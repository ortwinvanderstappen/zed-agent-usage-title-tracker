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
import { readCache, writeCache } from "./lib/cache.mjs";
import {
  describeWindows,
  formatWindows,
  maxUsedPercent,
  msUntilNextReset,
} from "./lib/windows.mjs";

const REFRESH_MS = Number(process.env.ZED_AGENT_USAGE_REFRESH_MS ?? 60_000);
const MIN_INTERVAL_MS = Number(process.env.ZED_AGENT_USAGE_MIN_INTERVAL_MS ?? 15_000);
// Labels count down, so they need re-rendering as time passes even when the
// numbers have not moved. Pure and cache-backed, so far cheaper than a fetch.
const RENDER_MS = Number(process.env.ZED_AGENT_USAGE_RENDER_MS ?? 30_000);
const DEBUG = process.env.ZED_AGENT_USAGE_DEBUG === "1";
const off = (v) => ["", "off", "none", "false", "0"].includes((v ?? "").toLowerCase());

/** Reuse a snapshot another proxy fetched within this window. Zed runs one proxy
 *  per window, so without this each pays for the same numbers. */
// `?? "on"` matters: off() counts an empty string as off, and unset must not.
const CACHE_MS = off(process.env.ZED_AGENT_USAGE_CACHE ?? "on")
  ? 0
  : Number(process.env.ZED_AGENT_USAGE_CACHE_MS ?? REFRESH_MS);

/** After this long without a successful read, say so rather than showing figures
 *  that have quietly stopped moving. */
const STALE_MS = Number(process.env.ZED_AGENT_USAGE_STALE_MS ?? 300_000);

/** Warning glyph shown above MARKER_AT percent. An emoji because ACP has no
 *  colour or severity field. `off` disables it; any other value replaces it. */
const MARKER = (() => {
  const raw = process.env.ZED_AGENT_USAGE_MARKER;
  if (raw === undefined) return "🔴";
  return off(raw.trim()) ? "" : raw.trim();
})();
const MARKER_AT = Number(process.env.ZED_AGENT_USAGE_MARKER_AT ?? 90);

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

log(`provider: ${provider.id}`);

/** ACP reserves the `_` prefix for custom use, so this cannot collide with an
 *  option a real adapter grows later. */
const USAGE_OPTION_ID = "_usage";
const USAGE_VALUE_ID = "current";

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
let lastFetch = 0;
let fetching = false;
/** When the current snapshot was read -- by us or by another proxy. */
let fetchedAt = 0;
/** Last published label, so fetch and render tick share one "did it change?". */
let lastSuffix = null;
/** Timer that re-reads usage just after a window rolls over. */
let resetTimer = null;
/** sessionId -> the adapter's own options, so each render starts from a clean
 *  set rather than appending to its own output. */
const rawConfigOptions = new Map();

function suffix() {
  return usage?.available ? formatWindows(usage.windows) : "";
}

/** Minutes since the snapshot was read, or null if it is still fresh. */
function staleMinutes() {
  if (!fetchedAt) return null;
  const age = Date.now() - fetchedAt;
  return age > STALE_MS ? Math.floor(age / 60_000) : null;
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
    currentValue: USAGE_VALUE_ID,
    options: [{ value: USAGE_VALUE_ID, name: label, description: detail || undefined }],
  };
}

/** Append-only: every real option passes through untouched. */
function withUsageOption(configOptions) {
  if (!Array.isArray(configOptions)) return configOptions;
  const mine = usageOption();
  return mine ? [...configOptions, mine] : configOptions;
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
          configOptions: withUsageOption(configOptions),
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
  resetTimer = setTimeout(() => void refreshUsage({ force: true }), Math.max(due, 0) + 2_000);
  resetTimer.unref?.();
}

async function refreshUsage({ force = false } = {}) {
  if (fetching) return;
  if (!force && Date.now() - lastFetch < MIN_INTERVAL_MS) return;
  fetching = true;
  try {
    // Another proxy may have just read this; reuse rather than spawn again.
    const shared = CACHE_MS ? readCache(provider.id, CACHE_MS) : null;
    const next = shared?.usage ?? (await provider.fetchUsage());
    lastFetch = Date.now();
    fetchedAt = shared?.fetchedAt ?? lastFetch;
    usage = next;
    if (!shared && CACHE_MS) writeCache(provider.id, { fetchedAt, usage: next });
    log(
      `usage:${formatWindows(next.windows) || " (none)"} available=${next.available}` +
        `${shared ? " (shared)" : ""}`,
    );
    renderSelectors();
    scheduleResetRefresh();
  } catch (err) {
    log(`usage fetch failed: ${err?.message || err}`);
  } finally {
    fetching = false;
  }
}

/** Inspect one agent -> client message, decorating the selector in place. */
function transform(message) {
  // Config options arrive on the session/new response, not a notification.
  if (message?.result?.configOptions) {
    const { sessionId, configOptions } = message.result;
    if (sessionId) rawConfigOptions.set(sessionId, configOptions);
    // Startup fetch failed or has not landed: retry so the label arrives now.
    if (!usage) void refreshUsage({ force: true });
    return {
      ...message,
      result: { ...message.result, configOptions: withUsageOption(configOptions) },
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
        update: { ...update, configOptions: withUsageOption(update.configOptions) },
      },
    };
  }

  // Adapters emit usage_update at turn end: a good moment to re-read.
  if (update.sessionUpdate === "usage_update") void refreshUsage();

  return message;
}

// ------------------------------------------------- relay: client -> agent

/** The adapter has never heard of our id, so it would reject the set-request
 *  Zed sends on click. Answer it here, with the full set the schema requires. */
function interceptFromClient(message) {
  if (message?.method !== "session/set_config_option") return false;
  if (message.params?.configId !== USAGE_OPTION_ID) return false;
  const sessionId = message.params?.sessionId;
  log(`answering set_config_option for ${USAGE_OPTION_ID} (session ${sessionId})`);
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { configOptions: withUsageOption(rawConfigOptions.get(sessionId) ?? []) },
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

void refreshUsage({ force: true });
setInterval(() => void refreshUsage(), REFRESH_MS).unref();
// Re-render between fetches so the countdown stays honest without a turn.
setInterval(renderSelectors, RENDER_MS).unref();
