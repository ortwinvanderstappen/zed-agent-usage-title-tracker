#!/usr/bin/env node
/**
 * Installs a shim over a registry-installed ACP adapter, so Zed's built-in
 * `claude-acp` / `codex-acp` agents run through the usage proxy -- keeping their
 * registry icons, which a `type: custom` settings entry cannot have.
 *
 *   node scripts/install-shim.mjs --status
 *   node scripts/install-shim.mjs claude codex
 *   node scripts/install-shim.mjs --uninstall claude codex
 *
 * The adapter's `dist/index.js` is moved aside to `dist/index.real.js` and
 * replaced by a launcher that runs proxy.mjs with ZED_AGENT_USAGE_ADAPTER_*
 * pointed at the real file.
 *
 * Caveat: Zed overwrites `dist/index.js` whenever it installs a new adapter
 * version, which silently removes the shim. Re-run this script after a Zed or
 * adapter update; `--status` tells you where things stand.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listProviders, loadProvider } from "../providers/index.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const proxy = path.join(repo, "proxy.mjs");
const MARKER = "zed-agent-usage-title-tracker shim v1";

/** Where a provider's adapter entry point lives, or null if Zed hasn't
 *  installed it (resolveAdapter falls back to npx, which we cannot shim). */
async function adapterEntry(id) {
  const provider = await loadProvider(id);
  const { command, args } = provider.resolveAdapter();
  if (command === "npx") return null;
  const entry = args[0];
  return entry && existsSync(entry) ? entry : null;
}

function shimSource({ providerId, real }) {
  // Dynamic import so the file works whether the host package is ESM or CJS.
  return `#!/usr/bin/env node
/* ${MARKER}
 * Installed by ${path.join(repo, "scripts/install-shim.mjs")}
 * Runs the usage proxy, which relays to the real adapter below.
 * Remove with: node ${path.join(repo, "scripts/install-shim.mjs")} --uninstall ${providerId}
 */
const PROXY = ${JSON.stringify(proxy)};
const REAL = ${JSON.stringify(real)};
const PROVIDER = ${JSON.stringify(providerId)};

import("node:child_process").then(({ spawn }) => {
  const child = spawn(process.execPath, [PROXY, "--provider", PROVIDER], {
    stdio: "inherit", // Zed's pipes pass straight through to the proxy
    env: {
      ...process.env,
      ZED_AGENT_USAGE_ADAPTER_COMMAND: process.execPath,
      ZED_AGENT_USAGE_ADAPTER_ARGS: JSON.stringify([REAL, ...process.argv.slice(2)]),
    },
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }
});
`;
}

const isShim = (file) => existsSync(file) && readFileSync(file, "utf8").includes(MARKER);

async function status(id) {
  const entry = await adapterEntry(id);
  if (!entry) return { id, state: "unavailable" };
  const real = path.join(path.dirname(entry), "index.real.js");
  if (isShim(entry)) return { id, state: "shimmed", entry, real };
  // A real adapter at index.js with a stale index.real.js beside it means Zed
  // reinstalled the adapter and wiped our shim.
  if (existsSync(real)) return { id, state: "wiped-by-update", entry, real };
  return { id, state: "clean", entry, real };
}

async function install(id) {
  const s = await status(id);
  if (s.state === "unavailable") {
    console.log(`${id}: adapter not installed by Zed -- open its agent once, then re-run`);
    return false;
  }
  if (s.state === "shimmed") {
    // Rewrite anyway, so a moved repo or renamed paths are picked up.
    writeFileSync(s.entry, shimSource({ providerId: id, real: s.real }));
    chmodSync(s.entry, 0o755);
    console.log(`${id}: shim refreshed`);
    return true;
  }
  // Both "clean" and "wiped-by-update" mean index.js is a genuine adapter:
  // it becomes the new index.real.js, replacing any stale copy.
  if (s.state === "wiped-by-update") unlinkSync(s.real);
  renameSync(s.entry, s.real);
  writeFileSync(s.entry, shimSource({ providerId: id, real: s.real }));
  chmodSync(s.entry, 0o755);
  console.log(`${id}: shim installed (real adapter -> ${path.basename(s.real)})`);
  return true;
}

async function uninstall(id) {
  const s = await status(id);
  if (s.state === "unavailable") {
    console.log(`${id}: adapter not installed`);
    return false;
  }
  if (!existsSync(s.real)) {
    console.log(`${id}: nothing to restore`);
    return false;
  }
  if (isShim(s.entry)) unlinkSync(s.entry);
  renameSync(s.real, s.entry);
  console.log(`${id}: real adapter restored`);
  return true;
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const ids = argv.filter((a) => !a.startsWith("--"));
const targets = ids.length ? ids : listProviders();

if (flags.has("--status")) {
  for (const id of targets) {
    const s = await status(id);
    console.log(`${id.padEnd(8)} ${s.state}${s.entry ? `  ${s.entry}` : ""}`);
  }
} else if (flags.has("--uninstall")) {
  for (const id of targets) await uninstall(id);
} else {
  for (const id of targets) await install(id);
  console.log(
    `\nRemove the "* + usage" entries from agent_servers -- the built-in\n` +
      `claude-acp / codex-acp agents now run through the proxy, with their icons.`,
  );
}
