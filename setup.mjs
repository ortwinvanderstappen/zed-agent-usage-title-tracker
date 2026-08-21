#!/usr/bin/env node
/** Print -- or apply -- the Zed settings entry for this machine.
 *
 *   node setup.mjs                      # show what to add, and where
 *   node setup.mjs --write              # add it, backing settings.json up first
 *   node setup.mjs --provider codex     # the Codex entry instead
 *   node setup.mjs --name "Claude"      # override the agent's display name
 *
 * Every path in the printed entry is resolved here rather than typed by hand,
 * because they all differ per platform: where Zed keeps settings, where it
 * installs adapters, and which node it downloaded.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insertAgentServer, toStrictJson } from "./lib/jsonc.mjs";
import { isWindows, resolveNode, zedSupportDirs } from "./lib/resolve.mjs";
import { listProviders, loadProvider } from "./providers/index.mjs";

const repo = path.dirname(fileURLToPath(import.meta.url));

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const write = process.argv.includes("--write");
const providerId = flag("provider") ?? process.env.ZED_AGENT_USAGE_PROVIDER ?? "claude";

/** Where Zed keeps settings.json. Note this is *not* the support directory that
 *  holds downloaded agents: on Windows settings live under %APPDATA% while
 *  agents live under %LOCALAPPDATA%. */
function settingsPath() {
  if (isWindows) {
    const appData = process.env.APPDATA ?? path.join(homedir(), "AppData/Roaming");
    return path.join(appData, "Zed", "settings.json");
  }
  return path.join(homedir(), ".config", "zed", "settings.json");
}

/** Forward slashes read better in JSON and Windows accepts them everywhere. */
const forJson = (p) => p.split(path.sep).join("/");

// ---------------------------------------------------------------- report

const provider = await loadProvider(providerId);
const name = flag("name") ?? `${provider.displayName} + usage`;
const launcher = path.join(repo, "bin", isWindows ? "zed-agent-usage.cmd" : "zed-agent-usage");
const settings = settingsPath();
const adapter = provider.resolveAdapter();

/** The settings entry. The launcher resolves node itself, so no node path is
 *  written to settings and Zed upgrading its node cannot stale this out.
 *
 *  Windows goes through cmd.exe rather than naming the .cmd directly: a batch
 *  file is not universally spawnable (node refuses outright since the
 *  CVE-2024-27980 mitigation), whereas cmd.exe is a real executable at a path
 *  that never moves. */
function settingsEntry() {
  const providerArgs = provider.id === "claude" ? [] : ["--provider", provider.id];
  if (isWindows) {
    const cmdExe = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe");
    return {
      type: "custom",
      command: forJson(cmdExe),
      args: ["/c", forJson(launcher), ...providerArgs],
    };
  }
  return { type: "custom", command: forJson(launcher), args: providerArgs };
}

const entry = settingsEntry();
const block = `${JSON.stringify(name)}: ${JSON.stringify(entry, null, 2)}`;

const rows = [
  ["platform", `${process.platform} ${process.arch}`],
  ["provider", `${provider.id}  (available: ${listProviders().join(", ")})`],
  ["launcher", existsSync(launcher) ? launcher : `${launcher}   MISSING`],
  ["node", resolveNode()],
  ["Zed support dir", zedSupportDirs().find((d) => existsSync(d)) ?? "not found"],
  ["Zed settings.json", existsSync(settings) ? settings : `${settings}   (will be created)`],
  [
    `${provider.id} adapter`,
    adapter.source === "zed"
      ? adapter.args.at(-1)
      : `not installed yet -- Zed downloads it on first use, or npx fetches ${adapter.args.at(-1)}`,
  ],
];
for (const [label, value] of rows) console.log(`${label.padEnd(18)}${value}`);

console.log(`\nEntry for "agent_servers" in ${settings}:\n`);
console.log(indent(block, "    "));

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

// ---------------------------------------------------------------- write

if (!write) {
  console.log(`\nRe-run with --write to add it, then pick "${name}" in Zed's agent`);
  console.log("panel picker. Existing entries are left alone.");
  process.exit(0);
}

const original = existsSync(settings) ? readFileSync(settings, "utf8") : "{\n}\n";

const parse = (text, what) => {
  try {
    return JSON.parse(toStrictJson(text));
  } catch (err) {
    console.error(`\nRefusing to write: ${what} (${err.message}).`);
    process.exit(1);
  }
};

if (parse(original, `${settings} does not parse`)?.agent_servers?.[name]) {
  console.log(`\nAlready present: "${name}". Nothing to do.`);
  process.exit(0);
}

const updated = insertAgentServer(original, block);
if (!parse(updated, "the result would not parse")?.agent_servers?.[name]) {
  console.error("\nRefusing to write: the entry is missing after insert.");
  process.exit(1);
}

if (existsSync(settings)) {
  copyFileSync(settings, `${settings}.bak`);
  console.log(`\nbacked up  ${settings}.bak`);
}
writeFileSync(settings, updated);
console.log(`updated    ${settings}`);
console.log(`\nPick "${name}" in Zed's agent panel picker -- no restart needed.`);
