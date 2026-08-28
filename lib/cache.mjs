/** A snapshot shared between proxies.
 *
 *  Zed runs one proxy per window, and each would otherwise spawn its own SDK
 *  subprocess every refresh for a number that is identical across all of them.
 *  They pass it through a small file instead, so N proxies cost one fetch.
 *
 *  Freshness alone is not enough: proxies that start together all miss the cache
 *  and all fetch at once. The lock below makes that a single fetch, with the
 *  others waiting for its result.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

/** Per-user directory, 0700, so a shared /tmp cannot be used to make us write
 *  through someone else's symlink. ZED_AGENT_USAGE_CACHE_DIR overrides it, which
 *  keeps tests out of the real record. */
function dir() {
  const who = (() => {
    try {
      const { uid, username } = userInfo();
      return uid >= 0 ? String(uid) : username;
    } catch {
      return "shared";
    }
  })();
  const target =
    process.env.ZED_AGENT_USAGE_CACHE_DIR || path.join(tmpdir(), `zed-agent-usage-${who}`);
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

/** Age of the stored snapshot in ms, or null if there is none. */
export function cacheAge(providerId) {
  try {
    const raw = JSON.parse(readFileSync(file(providerId), "utf8"));
    return typeof raw?.fetchedAt === "number" ? Date.now() - raw.fetchedAt : null;
  } catch {
    return null;
  }
}

/** Try to become the one process that fetches. Returns a release function, or
 *  null if someone else already holds it. `wx` fails if the file exists, which
 *  is what makes this atomic across processes.
 *
 *  A holder that dies mid-fetch would otherwise block everyone forever, so a
 *  lock older than `staleMs` is taken over. */
export function acquireFetchLock(providerId, staleMs = 30_000) {
  const lock = path.join(dir(), `${providerId}.lock`);
  const release = () => {
    try {
      rmSync(lock, { force: true });
    } catch {
      /* already gone */
    }
  };
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    return release;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        rmSync(lock, { force: true });
        return acquireFetchLock(providerId, staleMs);
      }
    } catch {
      /* vanished between the two calls; the next trigger will retry */
    }
    return null;
  }
}

/** Wait for whoever holds the lock to publish, so a loser of the race shows the
 *  same numbers rather than nothing. */
export async function waitForCache(providerId, ttlMs, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readCache(providerId, ttlMs);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Last-activity times per session, shared between proxies and surviving restarts.
 *  Zed does not store external-agent threads (its threads.db holds only native
 *  ones), so this is our own record of when a thread was last worked in. */
const activityFile = () => path.join(dir(), "session-activity.json");

export function readSessionActivity() {
  try {
    const raw = JSON.parse(readFileSync(activityFile(), "utf8"));
    return new Map(Object.entries(raw).filter(([, v]) => typeof v === "number"));
  } catch {
    return new Map();
  }
}

/** Merge our entries with whatever another proxy has written, keeping the newer
 *  of each, so two windows do not clobber each other's history. */
export function writeSessionActivity(entries) {
  const merged = readSessionActivity();
  for (const [id, at] of entries) {
    if (!merged.has(id) || merged.get(id) < at) merged.set(id, at);
  }
  const target = activityFile();
  const temp = `${target}.${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify(Object.fromEntries(merged)), { mode: 0o600 });
    renameSync(temp, target);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* nothing left to do */
    }
  }
  return merged;
}
