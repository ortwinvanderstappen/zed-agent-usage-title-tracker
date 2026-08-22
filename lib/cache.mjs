/** A snapshot shared between proxies.
 *
 *  Zed runs one proxy per window, and each would otherwise spawn its own SDK
 *  subprocess every refresh for a number that is identical across all of them.
 *  They pass it through a small file instead, so N proxies cost one fetch.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

/** Per-user directory, 0700, so a shared /tmp cannot be used to make us write
 *  through someone else's symlink. */
function dir() {
  const who = (() => {
    try {
      const { uid, username } = userInfo();
      return uid >= 0 ? String(uid) : username;
    } catch {
      return "shared";
    }
  })();
  const target = path.join(tmpdir(), `zed-agent-usage-${who}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}

const file = (providerId) => path.join(dir(), `${providerId}.json`);

/** The stored snapshot if it is younger than `ttlMs`, else null. Any problem --
 *  missing, corrupt, unreadable -- reads as a miss. */
export function readCache(providerId, ttlMs) {
  try {
    const raw = JSON.parse(readFileSync(file(providerId), "utf8"));
    if (typeof raw?.fetchedAt !== "number" || typeof raw?.usage !== "object") return null;
    if (Date.now() - raw.fetchedAt > ttlMs) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Write via a temp file and rename, so a concurrent reader never sees a
 *  half-written snapshot. Failures are ignored: the cache is an optimisation. */
export function writeCache(providerId, snapshot) {
  const target = file(providerId);
  const temp = `${target}.${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temp, target);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* nothing left to do */
    }
  }
}
