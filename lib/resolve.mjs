/** Locating the binaries Zed already installed, so providers need no npm install. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const isWindows = process.platform === "win32";

/** Zed's per-platform support directory, where external agents are installed.
 *  Windows keeps it under %LOCALAPPDATA%, not the home directory, so it has to
 *  come from the environment rather than `homedir()`. */
export function zedSupportDirs() {
  const dirs = [];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Zed")); // Windows
  dirs.push(
    path.join(homedir(), "Library/Application Support/Zed"), // macOS
    path.join(homedir(), ".local/share/zed"), // Linux
    path.join(homedir(), ".config/zed"),
  );
  return dirs;
}

/** Expand a path relative to Zed's external-agent registry into candidates.
 *  `relative` is relative to the support dir, e.g.
 *  "external_agents/registry/npx/codex-acp/node_modules/...". */
export function zedPaths(relative) {
  return zedSupportDirs().map((dir) => path.join(dir, relative));
}

/** First existing path from the list, or null. */
export function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function readdirOrEmpty(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeOrZero(target) {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/** Does `name` match a pattern whose only metacharacter is `*`?
 *  Hand-rolled rather than compiled to a RegExp so that package names
 *  containing regex metacharacters need no escaping. */
function wildcardMatch(name, pattern) {
  const parts = pattern.split("*");
  if (parts.length === 1) return name === pattern;

  const head = parts[0];
  const tail = parts[parts.length - 1];
  if (!name.startsWith(head) || !name.endsWith(tail)) return false;
  if (head.length + tail.length > name.length) return false;

  let pos = head.length;
  for (const part of parts.slice(1, -1)) {
    const at = name.indexOf(part, pos);
    if (at === -1) return false;
    pos = at + part.length;
  }
  return pos <= name.length - tail.length;
}

/** Expand a path template whose segments may contain `*`, most recently
 *  modified first. Deliberately not a general globber -- it only walks the
 *  small, known directories under Zed's registry, where platform-specific
 *  package and vendor names would otherwise have to be hardcoded per OS and
 *  architecture. */
export function expandPaths(base, segments) {
  let dirs = [base];
  for (const segment of segments) {
    const next = [];
    for (const dir of dirs) {
      if (!segment.includes("*")) {
        next.push(path.join(dir, segment));
        continue;
      }
      const matches = readdirOrEmpty(dir)
        .filter((name) => wildcardMatch(name, segment))
        .map((name) => path.join(dir, name))
        .sort((a, b) => mtimeOrZero(b) - mtimeOrZero(a));
      next.push(...matches);
    }
    dirs = next;
  }
  return dirs;
}

/** As `expandPaths`, but rooted at every candidate Zed support directory. */
export function zedGlob(segments) {
  return zedSupportDirs().flatMap((dir) => expandPaths(dir, segments));
}

/** The node binary to run this repo's scripts with.
 *
 *  Zed downloads its own node, so a machine with no system node still has one --
 *  which is the common case on Windows. The directory is version-stamped
 *  (`node-v24.11.0-win-x64`) and replaced when Zed upgrades node, so it is
 *  resolved at run time rather than written into settings.json. Preference
 *  order: an explicit override, Zed's newest node, then whatever is running us.
 */
export function resolveNode() {
  const explicit = firstExisting([process.env.ZED_AGENT_USAGE_NODE]);
  if (explicit) return explicit;

  const zedNode = firstExisting(
    zedGlob(["node", "node-v*"]).flatMap((dir) =>
      isWindows ? [path.join(dir, "node.exe")] : [path.join(dir, "bin", "node")],
    ),
  );
  return zedNode ?? process.execPath;
}

/** `npx` for the fallback path, preferring the one shipped beside `resolveNode`.
 *  A bare "npx" cannot be spawned on Windows -- it is `npx.cmd` there, and Zed's
 *  node directory is not on PATH -- so the CLI is invoked through node instead. */
function npxCommand() {
  const node = resolveNode();
  const cli = firstExisting([path.join(path.dirname(node), "node_modules/npm/bin/npx-cli.js")]);
  if (cli) return { command: node, args: [cli] };
  return { command: isWindows ? "npx.cmd" : "npx", args: [] };
}

/** Resolve an ACP adapter shipped as a Node entry point under Zed's registry.
 *  Falls back to fetching the package with npx. `source` says which happened,
 *  so callers can tell "reusing Zed's install" from "about to download". */
export function resolveNodeAdapter({ relative, npmPackage }) {
  const entry = firstExisting(zedPaths(relative));
  if (entry) return { command: resolveNode(), args: [entry], source: "zed" };
  const npx = npxCommand();
  return { command: npx.command, args: [...npx.args, "-y", npmPackage], source: "npx" };
}
