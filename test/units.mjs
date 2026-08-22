/** Unit tests for the shared cache and the Codex window mapping.
 *
 *  The Codex path in particular only ever sees one window on a Plus account, so
 *  the ordering and labelling below would otherwise first run in production. */
import assert from "node:assert/strict";
import { acquireFetchLock, readCache, waitForCache, writeCache } from "../lib/cache.mjs";
import { windowsFromRateLimits } from "../providers/codex.mjs";
import { formatWindows } from "../lib/windows.mjs";

// --- cache ----------------------------------------------------------------
const id = `test-${process.pid}`;
const snapshot = { fetchedAt: Date.now(), usage: { available: true, windows: [] } };

assert.equal(readCache(id, 60_000), null, "nothing cached yet");

writeCache(id, snapshot);
assert.deepEqual(readCache(id, 60_000)?.usage, snapshot.usage, "round-trips within the TTL");
assert.equal(readCache(id, 0), null, "expired by a zero TTL");

writeCache(id, { fetchedAt: Date.now() - 120_000, usage: { windows: [] } });
assert.equal(readCache(id, 60_000), null, "too old to reuse");

writeCache(id, { nonsense: true });
assert.equal(readCache(id, 60_000), null, "wrong shape reads as a miss");

// --- single-flight lock ---------------------------------------------------
// Without this, proxies started together all miss the cache and all fetch.
const lockId = `lock-${process.pid}`;
const first = acquireFetchLock(lockId);
assert.ok(first, "the first caller wins");
assert.equal(acquireFetchLock(lockId), null, "a second caller is turned away");
first();
const third = acquireFetchLock(lockId);
assert.ok(third, "released, so the next caller wins");
third();
// A holder that dies mid-fetch must not block everyone forever.
assert.ok(acquireFetchLock(lockId), "acquired for the staleness check");
assert.ok(acquireFetchLock(lockId, -1), "a stale lock is taken over");
acquireFetchLock(lockId, -1)?.();

// A loser gets whatever the winner published.
writeCache(lockId, { fetchedAt: Date.now(), usage: { available: true, windows: [] } });
assert.ok(await waitForCache(lockId, 60_000, 1_000), "published snapshot is visible");
assert.equal(await waitForCache(`missing-${process.pid}`, 60_000, 300), null, "times out cleanly");

// --- Codex windows --------------------------------------------------------
const primary5h = { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_787_000_000 };
const weekly = { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1_787_500_000 };

const both = windowsFromRateLimits({ primary: primary5h, secondary: weekly });
assert.equal(both.length, 2, "both windows kept");
assert.deepEqual(
  both.map((w) => w.label),
  ["5h", "wk"],
  "shortest window first",
);
assert.equal(
  formatWindows(both, { now: 1_786_000_000_000 }),
  " · 5h 42% · wk 7%",
  "renders in order",
);

assert.deepEqual(
  windowsFromRateLimits({ primary: weekly, secondary: primary5h }).map((w) => w.label),
  ["5h", "wk"],
  "sorted regardless of which slot they arrive in",
);

// A Plus account reports only the weekly window.
assert.deepEqual(
  windowsFromRateLimits({ primary: weekly, secondary: null }).map((w) => w.label),
  ["wk"],
  "one window is fine",
);

assert.deepEqual(windowsFromRateLimits({}), [], "nothing reported");
assert.deepEqual(
  windowsFromRateLimits({ primary: { windowDurationMins: 300 } }),
  [],
  "a window with no percentage is dropped",
);
assert.deepEqual(
  windowsFromRateLimits({ primary: { usedPercent: 5, windowDurationMins: 0 } }),
  [],
  "a window with no duration has no label, so it is dropped",
);

// Codex reports epoch seconds; the rest of the code expects a parseable stamp.
assert.equal(
  both[0].resetsAt,
  new Date(primary5h.resetsAt * 1000).toISOString(),
  "epoch seconds normalised to ISO",
);

console.log("PASS: cache and Codex window mapping");
