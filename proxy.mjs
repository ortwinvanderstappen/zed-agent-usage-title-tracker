#!/usr/bin/env node
/**
 * ACP stdio proxy that shows plan usage in Zed's agent panel.
 *
 *   Zed  <--stdio-->  proxy.mjs  <--stdio-->  <agent>-acp adapter
 *
 * The usage is appended to the label of one config selector at the bottom of the
 * thread -- "Xhigh · 1h 26% · wk 7%". `SessionConfigSelectOption.name` is
 * display-only (`value` is what `session/set_config_option` references), so
 * rewriting it round-trips safely. Everything else is relayed verbatim.
 *
 * Which agent to wrap, where its numbers come from, and which selector carries
 * them is decided by a provider (see providers/README.md):
 *
 *   node proxy.mjs                    # default provider: claude
 *   node proxy.mjs --provider codex
 */

import { spawn } from "node:child_process";
import { loadProvider } from "./providers/index.mjs";
import { formatWindows, msUntilNextReset } from "./lib/windows.mjs";

const REFRESH_MS = Number(process.env.ZED_AGENT_USAGE_REFRESH_MS ?? 60_000);
const MIN_INTERVAL_MS = Number(process.env.ZED_AGENT_USAGE_MIN_INTERVAL_MS ?? 15_000);
// Labels count down to the next reset, so the selector has to be re-rendered as
// time passes even when the numbers have not moved. Rendering is pure -- it
// reuses the cached snapshot -- so this tick is far cheaper than a fetch.
const RENDER_MS = Number(process.env.ZED_AGENT_USAGE_RENDER_MS ?? 30_000);
const DEBUG = process.env.ZED_AGENT_USAGE_DEBUG === "1";

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

/** Which config selector carries the usage. Each provider names its own, since
 *  the ids differ per agent ("effort" vs "reasoning_effort"); both are chosen
 *  for having short value labels, so the suffix fits where a long one like
 *  "Opus (1M context)" would be truncated by Zed. */
const SELECTOR_ID = process.env.ZED_AGENT_USAGE_SELECTOR ?? provider.selectorId ?? "effort";
log(`provider: ${provider.id} selector: ${SELECTOR_ID}`);

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

// Client -> agent is relayed untouched; nothing we inject travels upstream.
process.stdin.pipe(child.stdin);
process.stdin.on("end", () => child.stdin.end());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}

// ---------------------------------------------------------------- state

/** Latest snapshot from the provider, or null until the first success. */
let usage = null;
let lastFetch = 0;
let fetching = false;
/** Suffix last published, so the fetch and the render tick share one test for
 *  "would the display actually change?". */
let lastSuffix = null;
/** Timer that re-reads usage just after a window rolls over. */
let resetTimer = null;
/** sessionId -> the adapter's own config options, undecorated, so every render
 *  starts from a clean set rather than appending to an appended label. */
const rawConfigOptions = new Map();

function suffix() {
  return usage?.available ? formatWindows(usage.windows) : "";
}

/** Append the usage to the selected value of the provider's chosen selector.
 *  Only that one value is touched; every other option is passed through as-is. */
function decorateConfigOptions(configOptions) {
  const tail = suffix();
  if (!tail || !Array.isArray(configOptions)) return configOptions;
  return configOptions.map((opt) => {
    if (opt?.id !== SELECTOR_ID || !Array.isArray(opt.options)) return opt;
    return {
      ...opt,
      options: opt.options.map((v) =>
        v?.value === opt.currentValue ? { ...v, name: `${v.name}${tail}` } : v,
      ),
    };
  });
}

// ---------------------------------------------------------------- framing

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Re-emit config options so the selector label refreshes. Zed only re-reads the
 *  label when the set is republished, which is also what covers a cold start:
 *  `session/new` can arrive before the first usage fetch lands, leaving that
 *  first render undecorated. */
function republishConfigOptions() {
  for (const [sessionId, configOptions] of rawConfigOptions) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: decorateConfigOptions(configOptions),
        },
      },
    });
  }
}

/** Publish only when the rendered suffix has actually changed -- whether because
 *  the numbers moved or because the countdown ticked. */
function renderSelectors() {
  const next = suffix();
  if (next === lastSuffix) return;
  lastSuffix = next;
  republishConfigOptions();
}

/** A window that has just rolled over leaves a stale percentage cached, so
 *  schedule one fetch for shortly after the soonest reset. */
function scheduleResetRefresh() {
  clearTimeout(resetTimer);
  const due = msUntilNextReset(usage?.windows);
  if (due == null) return;
  // A couple of seconds of slack, and never a busy loop on a past timestamp.
  resetTimer = setTimeout(() => void refreshUsage({ force: true }), Math.max(due, 0) + 2_000);
  resetTimer.unref?.();
}

async function refreshUsage({ force = false } = {}) {
  if (fetching) return;
  if (!force && Date.now() - lastFetch < MIN_INTERVAL_MS) return;
  fetching = true;
  try {
    const next = await provider.fetchUsage();
    lastFetch = Date.now();
    usage = next;
    log(`usage:${formatWindows(next.windows) || " (none)"} available=${next.available}`);
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
  // Config options arrive on the session/new response, not as a notification,
  // so responses have to be inspected too.
  if (message?.result?.configOptions) {
    const { sessionId, configOptions } = message.result;
    if (sessionId) rawConfigOptions.set(sessionId, configOptions);
    // If the startup fetch failed or has not landed, try again now so the first
    // republish arrives promptly rather than at the next interval.
    if (!usage) void refreshUsage({ force: true });
    return {
      ...message,
      result: { ...message.result, configOptions: decorateConfigOptions(configOptions) },
    };
  }

  if (message?.method !== "session/update") return message;
  const sessionId = message.params?.sessionId;
  const update = message.params?.update;
  if (!sessionId || !update) return message;

  // Keep the selector decorated when the adapter republishes the option set --
  // e.g. after the user switches mode or model.
  if (update.sessionUpdate === "config_option_update") {
    rawConfigOptions.set(sessionId, update.configOptions);
    return {
      ...message,
      params: {
        ...message.params,
        update: { ...update, configOptions: decorateConfigOptions(update.configOptions) },
      },
    };
  }

  // Adapters emit usage_update at turn end -- a good moment to re-read the plan.
  if (update.sessionUpdate === "usage_update") void refreshUsage();

  return message;
}

// ---------------------------------------------------------------- relay

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
