#!/usr/bin/env node
/**
 * ACP stdio proxy: Zed <--> proxy.mjs <--> <agent>-acp adapter.
 *
 * Appends a read-only usage selector to the session's config options and relays
 * everything else verbatim. A provider decides which agent to wrap and where the
 * numbers come from (see providers/README.md).
 *
 *   node proxy.mjs [--provider codex]
 */

import { spawn } from "node:child_process";
import { loadProvider } from "./providers/index.mjs";
import {
  acquireFetchLock,
  readCache,
  readSessionActivity,
  waitForCache,
  writeCache,
  writeSessionActivity,
} from "./lib/cache.mjs";
import {
  clampPercent,
  describeWindows,
  formatWindows,
  maxUsedPercent,
  msUntilNextReset,
} from "./lib/windows.mjs";

/** Usage only moves when a turn runs, so refreshes are triggered by turns --
 *  starting one and finishing one -- rather than by the clock.
 *
 *  MIN_AGE is the floor: however many chats fire triggers, a real fetch happens
 *  at most this often across every proxy on the machine. MAX_AGE is the ceiling:
 *  if nothing has triggered for that long, refresh anyway so a long-idle window
 *  is not showing yesterday's figures. Both are measured against the shared
 *  snapshot, which is how the interval is kept across chats and windows. */
const MIN_AGE_MS = Number(process.env.ZED_AGENT_USAGE_MIN_AGE_MS ?? 60_000);
const MAX_AGE_MS = Number(process.env.ZED_AGENT_USAGE_MAX_AGE_MS ?? 900_000);
// Labels count down, so they need re-rendering as time passes even when the
// numbers have not moved. Pure and cache-backed, so far cheaper than a fetch.
const RENDER_MS = Number(process.env.ZED_AGENT_USAGE_RENDER_MS ?? 30_000);
const DEBUG = process.env.ZED_AGENT_USAGE_DEBUG === "1";
const off = (v) => ["", "off", "none", "false", "0"].includes((v ?? "").toLowerCase());

/** Reuse a snapshot another proxy fetched within this window. Zed runs one proxy
 *  per window, so without this each pays for the same numbers. */
// `?? "on"` matters: off() counts an empty string as off, and unset must not.
const SHARING = !off(process.env.ZED_AGENT_USAGE_CACHE ?? "on");

/** Consecutive failed reads before the label admits it. Keyed on failure rather
 *  than age: idling on purpose is not the same as being unable to read, and an
 *  age-based marker flags every idle window for no reason. Two, so a single
 *  transient blip stays quiet. */
const STALE_AFTER_FAILURES = Number(process.env.ZED_AGENT_USAGE_STALE_AFTER ?? 2);

/** No turns for this long means nobody is working: stop the safety net entirely.
 *  Turn start is a trigger, so it refreshes the moment work resumes, and window
 *  resets still fire, which bounds how old the figures can get. */
const IDLE_AFTER_MS = Number(process.env.ZED_AGENT_USAGE_IDLE_AFTER_MS ?? 600_000);

/** Config-option ids to drop from the row. Useful for selectors you have already
 *  pinned in settings.json and do not want to look at. Run with
 *  ZED_AGENT_USAGE_DEBUG=1 to see the available ids. */
const HIDDEN = new Set(
  (process.env.ZED_AGENT_USAGE_HIDE ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Warning glyph shown above MARKER_AT percent. An emoji because ACP has no
 *  colour or severity field. `off` disables it; any other value replaces it. */
const MARKER = (() => {
  const raw = process.env.ZED_AGENT_USAGE_MARKER;
  if (raw === undefined) return "🔴";
  return off(raw.trim()) ? "" : raw.trim();
})();
/** Percentage above which MARKER appears, 0-100. 0 warns at any usage, 100
 *  never does. */
const MARKER_AT = clampPercent(process.env.ZED_AGENT_USAGE_MARKER_AT, 90);

const log = (msg) => {
  if (DEBUG) process.stderr.write(`[agent-usage] ${msg}\n`);
};

function providerId() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--provider");
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  const bare = argv.find((a) => !a.startsWith("-"));
  return bare ?? process.env.ZED_AGENT_USAGE_PROVIDER ?? "claude";
}

const provider = await loadProvider(providerId());

log(`provider: ${provider.id}, marker ${MARKER || "off"} above ${MARKER_AT}%`);

/** ACP reserves the `_` prefix for custom use, so this cannot collide with an
 *  option a real adapter grows later. */
const USAGE_OPTION_ID = "_usage";
const LAST_ACTIVITY_OPTION_ID = "_lastActivity";
const OWN_VALUE_ID = "current";
/** Both injected ids, so a set-request for either can be answered here. */
const OWN_OPTION_IDS = new Set([USAGE_OPTION_ID, LAST_ACTIVITY_OPTION_ID]);

/** Shows when a thread was last worked in. Zed renders `updatedAt` as "9m",
 *  which is no help on returning to a thread days later, and the format is not
 *  ours to change -- so state it plainly instead. `off` disables. */
const SHOW_LAST_ACTIVITY = !off(process.env.ZED_AGENT_USAGE_LAST_ACTIVITY ?? "on");

// ---------------------------------------------------------------- adapter

function adapterCommand() {
  if (process.env.ZED_AGENT_USAGE_ADAPTER_COMMAND) {
    return {
      command: process.env.ZED_AGENT_USAGE_ADAPTER_COMMAND,
      args: process.env.ZED_AGENT_USAGE_ADAPTER_ARGS
        ? JSON.parse(process.env.ZED_AGENT_USAGE_ADAPTER_ARGS)
        : [],
    };
  }
  return provider.resolveAdapter();
}

const { command, args } = adapterCommand();
log(`spawning adapter: ${command} ${args.join(" ")}`);

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"], // stderr passes through to Zed's ACP log
  env: process.env,
});

child.on("error", (err) => {
  process.stderr.write(`[agent-usage] failed to spawn adapter: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

process.stdin.on("end", () => child.stdin.end());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}

// ---------------------------------------------------------------- state

/** Latest snapshot from the provider, or null until the first success. */
let usage = null;
let fetching = false;
/** When the current snapshot was read -- by us or by another proxy. */
let fetchedAt = 0;
/** Failed reads in a row; resets on any success. */
let failures = 0;
/** Last sign of someone actually working in this proxy. */
let lastTurnAt = Date.now();
/** Last published label, so fetch and render tick share one "did it change?". */
let lastSuffix = null;
/** Timer that re-reads usage just after a window rolls over. */
let resetTimer = null;
/** sessionId -> the adapter's own options, so each render starts from a clean
 *  set rather than appending to its own output. */
const rawConfigOptions = new Map();
/** sessionId -> epoch ms of the last turn, from the agent's own session records
 *  where available and from what we observe otherwise. */
let sessionActivity = SHOW_LAST_ACTIVITY ? readSessionActivity() : new Map();
/** Request id -> sessionId, for responses that omit it. `session/load` carries
 *  the id only in the request, so a resumed thread would otherwise never be
 *  registered here and its label would freeze at whatever it loaded with. */
const pendingSessionIds = new Map();

function suffix() {
  return usage?.available ? formatWindows(usage.windows) : "";
}

/** Minutes since the snapshot was read, or null while reads are healthy. */
function staleMinutes() {
  if (!fetchedAt || failures < STALE_AFTER_FAILURES) return null;
  return Math.floor((Date.now() - fetchedAt) / 60_000);
}

/** The label Zed shows: the windows, a marker when one is running out, and a
 *  "?" when the numbers have stopped being refreshed. */
function usageLabel() {
  const tail = suffix();
  if (!tail) return "";
  const label = tail.slice(3); // drop the leading " · "
  const worst = maxUsedPercent(usage?.windows);
  const warn = MARKER && worst != null && worst > MARKER_AT;
  return `${warn ? `${MARKER} ` : ""}${label}${staleMinutes() == null ? "" : " ?"}`;
}

/** Our selector. Single-value so it reads as a label, and no `category` so Zed
 *  does not treat it as a model or mode picker. */
function usageOption() {
  const label = usageLabel();
  if (!label) return null;
  const stale = staleMinutes();
  const detail = [
    describeWindows(usage?.windows),
    stale == null ? null : `last read ${stale}m ago`,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: USAGE_OPTION_ID,
    name: "Usage",
    description: detail || "Plan usage",
    type: "select",
    currentValue: OWN_VALUE_ID,
    options: [{ value: OWN_VALUE_ID, name: label, description: detail || undefined }],
  };
}

/** Absolute date and time, since "9m ago" is what we are trying to improve on. */
function formatActivity(at) {
  return new Date(at).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Our second selector: when this thread was last worked in. Omitted entirely
 *  when unknown, rather than guessing. */
function lastActivityOption(sessionId) {
  if (!SHOW_LAST_ACTIVITY) return null;
  const at = sessionActivity.get(sessionId);
  if (!at) return null;
  const label = formatActivity(at);
  return {
    id: LAST_ACTIVITY_OPTION_ID,
    name: "Last activity",
    description: `This thread was last active ${label}`,
    type: "select",
    currentValue: OWN_VALUE_ID,
    options: [{ value: OWN_VALUE_ID, name: label }],
  };
}

/** The row Zed renders: the adapter's options minus any hidden, plus ours. Kept
 *  options pass through untouched -- only the set membership changes. */
function withOwnOptions(configOptions, sessionId) {
  if (!Array.isArray(configOptions)) return configOptions;
  const kept = HIDDEN.size ? configOptions.filter((opt) => !HIDDEN.has(opt?.id)) : configOptions;
  const mine = [usageOption(), lastActivityOption(sessionId)].filter(Boolean);
  return mine.length ? [...kept, ...mine] : kept;
}

/** Record a turn, and tell the client about it. `at` comes from the agent's own
 *  record when we have it, otherwise now. */
function noteActivity(sessionId, at = Date.now()) {
  if (!SHOW_LAST_ACTIVITY || !sessionId || !at) return;
  if ((sessionActivity.get(sessionId) ?? 0) >= at) return;
  sessionActivity.set(sessionId, at);
  sessionActivity = writeSessionActivity(sessionActivity);
  if (rawConfigOptions.has(sessionId)) republishConfigOptions();
}

// ---------------------------------------------------------------- framing

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Zed only re-reads the label when the set is republished. This also covers a
 *  cold start, where session/new beats the first fetch. */
function republishConfigOptions() {
  for (const [sessionId, configOptions] of rawConfigOptions) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: withOwnOptions(configOptions, sessionId),
        },
      },
    });
  }
}

/** Publish only when the rendered label actually changed. */
function renderSelectors() {
  const next = usageLabel();
  if (next === lastSuffix) return;
  lastSuffix = next;
  republishConfigOptions();
}

/** A rolled-over window leaves a stale percentage cached, so re-read just after
 *  the soonest reset. */
function scheduleResetRefresh() {
  clearTimeout(resetTimer);
  const due = msUntilNextReset(usage?.windows);
  if (due == null) return;
  // Slack, and never a busy loop on a past timestamp.
  resetTimer = setTimeout(
    () => void refreshUsage({ maxAge: 0, reason: "window reset" }),
    Math.max(due, 0) + 2_000,
  );
  resetTimer.unref?.();
}

/** Refresh if the shared snapshot is older than `maxAge`.
 *
 *  Only one process fetches: the lock winner spawns the provider, everyone else
 *  waits for its result. Without that, proxies started together would all miss
 *  the cache and all spawn at once. */
async function refreshUsage({ maxAge = MIN_AGE_MS, reason = "" } = {}) {
  if (fetching) return;
  fetching = true;
  try {
    const shared = SHARING ? readCache(provider.id, maxAge) : null;
    if (shared) {
      adopt(shared, `${reason} (shared)`);
      return;
    }

    let release = SHARING ? acquireFetchLock(provider.id) : () => {};
    if (!release) {
      const waited = await waitForCache(provider.id, MAX_AGE_MS);
      if (waited) {
        adopt(waited, `${reason} (published by another proxy)`);
        return;
      }
      // The holder died or is slower than our patience. Showing nothing is the
      // worst outcome, so do the work here rather than return empty-handed.
      log(`${reason}: waited but no snapshot appeared; fetching here instead`);
      release = () => {};
    }

    try {
      const next = await provider.fetchUsage();
      const snapshot = { fetchedAt: Date.now(), usage: next };
      if (SHARING) writeCache(provider.id, snapshot);
      adopt(snapshot, `${reason} (fetched)`);
    } finally {
      release();
    }
  } catch (err) {
    failures += 1;
    log(`usage fetch failed (${failures} in a row): ${err?.message || err}`);
    renderSelectors(); // the label may need to admit it now
  } finally {
    fetching = false;
  }
}

/** Take a snapshot as current, whoever produced it. */
function adopt(snapshot, note) {
  failures = 0;
  usage = snapshot.usage;
  fetchedAt = snapshot.fetchedAt;
  log(`usage:${formatWindows(usage.windows) || " (none)"} ${note}`);
  renderSelectors();
  scheduleResetRefresh();
}

/** Inspect one agent -> client message, decorating the selector in place. */
function transform(message) {
  // Only a response can answer one of our recorded requests; an agent->client
  // request has its own id space and must not consume the entry.
  const isResponse = message?.id !== undefined && ("result" in message || "error" in message);
  const answered = isResponse ? pendingSessionIds.get(message.id) : undefined;
  if (isResponse) pendingSessionIds.delete(message.id);

  // session/list is how Zed populates its thread list, and each SessionInfo
  // carries the agent's own updatedAt -- history we could not otherwise know.
  if (Array.isArray(message?.result?.sessions)) {
    for (const info of message.result.sessions) {
      const at = info?.updatedAt ? Date.parse(info.updatedAt) : NaN;
      if (info?.sessionId && Number.isFinite(at)) noteActivity(info.sessionId, at);
    }
  }

  // Config options arrive on the session/new and session/load responses.
  if (message?.result?.configOptions) {
    const { configOptions } = message.result;
    const sessionId = message.result.sessionId ?? answered;
    if (sessionId) rawConfigOptions.set(sessionId, configOptions);
    log(`config options: ${configOptions.map((o) => o?.id).join(", ")}`);
    // Startup fetch failed or has not landed: retry so the label arrives now.
    if (!usage) void refreshUsage({ reason: "session start" });
    return {
      ...message,
      result: { ...message.result, configOptions: withOwnOptions(configOptions, sessionId) },
    };
  }

  if (message?.method !== "session/update") return message;
  const sessionId = message.params?.sessionId;
  const update = message.params?.update;
  if (!sessionId || !update) return message;

  // Re-inject when the adapter republishes its set, e.g. after a mode switch.
  if (update.sessionUpdate === "config_option_update") {
    rawConfigOptions.set(sessionId, update.configOptions);
    return {
      ...message,
      params: {
        ...message.params,
        update: { ...update, configOptions: withOwnOptions(update.configOptions, sessionId) },
      },
    };
  }

  // Turn end: the one moment the numbers are guaranteed to have moved.
  if (update.sessionUpdate === "usage_update") {
    lastTurnAt = Date.now();
    noteActivity(sessionId);
    void refreshUsage({ reason: "turn end" });
  }

  return message;
}

// ------------------------------------------------- relay: client -> agent

/** The adapter has never heard of our id, so it would reject the set-request
 *  Zed sends on click. Answer it here, with the full set the schema requires. */
function interceptFromClient(message) {
  // Remember which session a request belongs to; its response may not say.
  if (message?.id !== undefined && message.params?.sessionId) {
    pendingSessionIds.set(message.id, message.params.sessionId);
  }
  // Turn start: worth a look before the user commits to a prompt.
  if (message?.method === "session/prompt") {
    lastTurnAt = Date.now();
    noteActivity(message.params?.sessionId);
    void refreshUsage({ reason: "turn start" });
  }

  // An archived or closed thread must stop being re-rendered.
  if (message?.method === "session/close" || message?.method === "session/delete") {
    const gone = message.params?.sessionId;
    if (gone && rawConfigOptions.delete(gone)) log(`forgot session ${gone}`);
    if (gone) sessionActivity.delete(gone);
  }

  if (message?.method !== "session/set_config_option") return false;
  if (!OWN_OPTION_IDS.has(message.params?.configId)) return false;
  const sessionId = message.params?.sessionId;
  log(`answering set_config_option for ${message.params.configId} (session ${sessionId})`);
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { configOptions: withOwnOptions(rawConfigOptions.get(sessionId) ?? [], sessionId) },
    });
  }
  return true;
}

let upstream = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  upstream += chunk;
  let index;
  while ((index = upstream.indexOf("\n")) !== -1) {
    const line = upstream.slice(0, index);
    upstream = upstream.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      child.stdin.write(`${line}\n`); // not JSON: pass through untouched
      continue;
    }
    try {
      if (interceptFromClient(message)) continue;
    } catch (err) {
      log(`intercept failed, forwarding: ${err?.message || err}`);
    }
    child.stdin.write(`${line}\n`);
  }
});

// ------------------------------------------------- relay: agent -> client

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`); // not JSON: pass through untouched
      continue;
    }
    try {
      send(transform(message));
    } catch (err) {
      log(`transform failed, passing through: ${err?.message || err}`);
      process.stdout.write(`${line}\n`);
    }
  }
});
child.stdout.on("end", () => {
  if (buffer.trim()) process.stdout.write(`${buffer}\n`);
});

void refreshUsage({ reason: "startup" });
// Safety net, but only while someone is working. An idle Zed costs nothing.
// Checking more often than MAX_AGE is pointless; less often would overshoot it.
setInterval(
  () => {
    if (Date.now() - lastTurnAt > IDLE_AFTER_MS) return;
    void refreshUsage({ maxAge: MAX_AGE_MS, reason: "between turns" });
  },
  Math.max(2_000, Math.min(60_000, MAX_AGE_MS)),
).unref();
// Re-render between fetches so the countdown stays honest without a turn.
setInterval(renderSelectors, RENDER_MS).unref();
