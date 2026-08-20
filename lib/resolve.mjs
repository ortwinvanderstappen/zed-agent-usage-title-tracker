/** Locating the binaries Zed already installed, so providers need no npm install. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Zed's per-platform support directory, where external agents are installed. */
const ZED_SUPPORT_DIRS = [
  path.join(homedir(), "Library/Application Support/Zed"), // macOS
  path.join(homedir(), ".local/share/zed"), // Linux
  path.join(homedir(), ".config/zed"),
];

/** Expand a path relative to Zed's external-agent registry into candidates.
 *  `relative` is relative to the support dir, e.g.
 *  "external_agents/registry/npx/codex-acp/node_modules/...". */
export function zedPaths(relative) {
  return ZED_SUPPORT_DIRS.map((dir) => path.join(dir, relative));
}

/** First existing path from the list, or null. */
export function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve an ACP adapter shipped as a Node entry point under Zed's registry.
 *  Falls back to fetching the package with npx. */
export function resolveNodeAdapter({ relative, npmPackage }) {
  const entry = firstExisting(zedPaths(relative));
  if (entry) return { command: process.execPath, args: [entry] };
  return { command: "npx", args: ["-y", npmPackage] };
}
