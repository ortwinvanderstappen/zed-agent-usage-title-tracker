#!/usr/bin/env node
/**
 * ACP stdio proxy that appends plan usage to the Zed thread title.
 *
 *   Zed  <--stdio-->  proxy.mjs  <--stdio-->  <agent>-acp adapter
 *
 * Zed renders `session_info_update.title`, so the percentages are appended
 * there: "Fix auth bug · 5h 16% · wk 62%". Everything else is relayed verbatim.
 *
 * Which agent to wrap, and where its numbers come from, is decided by a provider
 * (see providers/README.md):
 *
 *   node proxy.mjs                    # default provider: claude
 *   node proxy.mjs --provider codex
 */

import { spawn } from "node:child_process";
import { loadProvider } from "./providers/index.mjs";
import { formatWindows, sameWindows, SUFFIX_RE } from "./lib/windows.mjs";

const REFRESH_MS = Number(process.env.ZED_AGENT_USAGE_REFRESH_MS ?? 60_000);
const MIN_INTERVAL_MS = Number(process.env.ZED_AGENT_USAGE_MIN_INTERVAL_MS ?? 15_000);
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
log(`provider: ${provider.id}`);

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

/** sessionId -> base title as reported by the adapter (may be null). */
const baseTitles = new Map();
/** Latest snapshot from the provider, or null until the first success. */
let usage = null;
let lastFetch = 0;
let fetching = false;

function suffix() {
  return usage?.available ? formatWindows(usage.windows) : "";
}

/** Compose the title Zed should display for a session. */
function decorate(sessionId) {
  const base = (baseTitles.get(sessionId) ?? "").replace(SUFFIX_RE, "");
  const tail = suffix();
  if (!tail) return base || null;
  // Before the adapter reports a title, show the percentages alone; the next
  // session_info_update replaces this with "<real title> · <percentages>".
  return base ? `${base}${tail}` : tail.slice(3);
}

// ---------------------------------------------------------------- framing

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Emit our own session_info_update so titles refresh between turns. */
function republishTitles() {
  for (const sessionId of baseTitles.keys()) {
    const title = decorate(sessionId);
    if (title == null) continue;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "session_info_update", title } },
    });
  }
}

async function refreshUsage({ force = false } = {}) {
  if (fetching) return;
  if (!force && Date.now() - lastFetch < MIN_INTERVAL_MS) return;
  fetching = true;
  try {
    const next = await provider.fetchUsage();
    lastFetch = Date.now();
    const changed = !usage || !sameWindows(next.windows, usage.windows);
    usage = next;
    log(`usage:${formatWindows(next.windows) || " (none)"} available=${next.available}`);
    if (changed) republishTitles();
  } catch (err) {
    log(`usage fetch failed: ${err?.message || err}`);
  } finally {
    fetching = false;
  }
}

/** Inspect one agent -> client message, rewriting titles in place. */
function transform(message) {
  if (message?.method !== "session/update") return message;
  const sessionId = message.params?.sessionId;
  const update = message.params?.update;
  if (!sessionId || !update) return message;

  if (update.sessionUpdate === "session_info_update" && "title" in update) {
    // Record what the adapter thinks the title is, then re-append our suffix.
    baseTitles.set(sessionId, update.title ?? null);
    const title = decorate(sessionId);
    return { ...message, params: { ...message.params, update: { ...update, title } } };
  }

  if (!baseTitles.has(sessionId)) {
    // First sighting of this session: register it so refreshes reach it.
    baseTitles.set(sessionId, null);
    if (usage) republishTitles();
    else void refreshUsage({ force: true });
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
