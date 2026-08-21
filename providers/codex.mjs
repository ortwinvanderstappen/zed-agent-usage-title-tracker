/** Codex provider.
 *
 *  codex-acp drops rate-limit data entirely, so there is nothing to sniff off
 *  the ACP stream. Instead this asks `codex app-server` directly: JSON-RPC
 *  `account/rateLimits/read`, which is an account metadata read and consumes no
 *  quota.
 *
 *  Codex reports windows by duration rather than by name, and which windows
 *  exist depends on the plan -- a Plus account may report only the weekly
 *  window, with `secondary: null`. Labels are therefore derived from
 *  `windowDurationMins`.
 */

import { spawn } from "node:child_process";
import { firstExisting, isWindows, resolveNodeAdapter, zedGlob } from "../lib/resolve.mjs";
import { labelForMinutes } from "../lib/windows.mjs";

const ADAPTER_REL =
  "external_agents/registry/npx/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js";
// The codex binary ships in a per-platform package (@openai/codex-win32-x64,
// @openai/codex-darwin-arm64, ...) under a per-target vendor directory. Both
// names are matched with wildcards so a new platform or architecture needs no
// code change -- hardcoding one triple made this resolvable on macOS only.
const CODEX_BIN_GLOB = [
  "external_agents",
  "registry",
  "npx",
  "codex-acp",
  "node_modules",
  "@openai",
  "codex-*",
  "vendor",
  "*",
  "bin",
  isWindows ? "codex.exe" : "codex",
];

function resolveCodexBinary() {
  const found = firstExisting([
    process.env.CODEX_BIN,
    ...zedGlob(CODEX_BIN_GLOB),
    ...(isWindows ? [] : ["/usr/local/bin/codex", "/opt/homebrew/bin/codex"]),
  ]);
  return found ?? "codex"; // fall back to PATH
}

/** One window from Codex's RateLimitWindow shape. */
function toWindow(raw) {
  if (!raw || typeof raw.usedPercent !== "number") return null;
  const label = labelForMinutes(raw.windowDurationMins);
  if (!label) return null;
  return {
    label,
    minutes: raw.windowDurationMins,
    usedPercent: raw.usedPercent,
    // Codex reports epoch seconds; normalise to ISO for consistency.
    resetsAt: typeof raw.resetsAt === "number" ? new Date(raw.resetsAt * 1000).toISOString() : null,
  };
}

export default {
  id: "codex",
  displayName: "Codex",

  resolveAdapter() {
    return resolveNodeAdapter({
      relative: ADAPTER_REL,
      npmPackage: "@agentclientprotocol/codex-acp",
    });
  },

  async fetchUsage({ timeoutMs = 20_000 } = {}) {
    const bin = resolveCodexBinary();
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });

    return new Promise((resolve, reject) => {
      const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
      const done = (fn, value) => {
        clearTimeout(timer);
        child.kill();
        fn(value);
      };
      const timer = setTimeout(
        () => done(reject, new Error("codex app-server timed out")),
        timeoutMs,
      );

      child.on("error", (err) => done(reject, err));

      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          if (msg.id === 1) {
            if (msg.error) return done(reject, new Error(`initialize failed: ${msg.error.message}`));
            send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
          } else if (msg.id === 2) {
            if (msg.error) {
              return done(reject, new Error(`rateLimits/read failed: ${msg.error.message}`));
            }
            const limits = msg.result?.rateLimits ?? {};
            const windows = [toWindow(limits.primary), toWindow(limits.secondary)]
              .filter(Boolean)
              // Shortest window first, so "5h" precedes "wk".
              .sort((a, b) => a.minutes - b.minutes);
            return done(resolve, {
              available: windows.length > 0,
              planType: limits.planType ?? null,
              windows,
            });
          }
        }
      });

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          capabilities: { experimentalApi: true, requestAttestation: false },
          clientInfo: {
            name: "zed-agent-usage-title-tracker",
            version: "0.3.0",
            title: "zed-agent-usage-title-tracker",
          },
        },
      });
    });
  },
};
