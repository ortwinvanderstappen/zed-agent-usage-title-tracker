/** Unit tests for the countdown labelling in lib/windows.mjs.
 *
 *  Everything is evaluated against a fixed `now`, so these never depend on the
 *  wall clock, the network, or an account. */
import assert from "node:assert/strict";
import {
  countdownLabel,
  describeWindows,
  formatWindows,
  labelForMinutes,
  maxUsedPercent,
  msUntil,
  msUntilNextReset,
  windowLabel,
} from "../lib/windows.mjs";

const NOW = Date.parse("2026-08-21T16:35:00Z");
const inMinutes = (m) => new Date(NOW + m * 60_000).toISOString();

// --- msUntil accepts both shapes providers produce -------------------------
assert.equal(msUntil(inMinutes(30), NOW), 30 * 60_000, "ISO string");
assert.equal(msUntil((NOW + 30 * 60_000) / 1000, NOW), 30 * 60_000, "epoch seconds");
assert.equal(msUntil(NOW + 30 * 60_000, NOW), 30 * 60_000, "epoch millis");
assert.equal(msUntil(null, NOW), null, "absent");
assert.equal(msUntil("not a date", NOW), null, "unparseable");
assert.equal(msUntil(Number.NaN, NOW), null, "NaN");

// --- countdownLabel floors to a single unit --------------------------------
assert.equal(countdownLabel(29 * 60_000), "29m", "29m stays minutes");
assert.equal(countdownLabel(80 * 60_000), "1h", "1h20m floors to 1h");
assert.equal(countdownLabel(59 * 60_000 + 59_000), "59m", "just under an hour");
assert.equal(countdownLabel(60 * 60_000), "1h", "exactly an hour");
assert.equal(countdownLabel(23.9 * 60 * 60_000), "23h", "just under a day");
assert.equal(countdownLabel(6.5 * 24 * 60 * 60_000), "6d", "6d12h floors to 6d");
assert.equal(countdownLabel(-5000), "0m", "past resets clamp to 0m");
assert.equal(countdownLabel(null), null, "no input");

// --- windowLabel: countdown when near, static label when far --------------
assert.equal(
  windowLabel({ label: "5h", resetsAt: inMinutes(94) }, NOW),
  "1h",
  "rolling window counts down",
);
assert.equal(
  windowLabel({ label: "wk", resetsAt: inMinutes(6 * 24 * 60) }, NOW),
  "wk",
  "weekly keeps its label while far off",
);
assert.equal(
  windowLabel({ label: "wk", resetsAt: inMinutes(8 * 60) }, NOW),
  "8h",
  "weekly counts down inside its final day",
);
assert.equal(
  windowLabel({ label: "5h", resetsAt: null }, NOW),
  "5h",
  "falls back to the static label",
);

// --- formatWindows renders the whole suffix -------------------------------
const usage = [
  { label: "5h", usedPercent: 26, resetsAt: inMinutes(94) },
  { label: "wk", usedPercent: 7, resetsAt: inMinutes(6 * 24 * 60) },
];
assert.equal(formatWindows(usage, { now: NOW }), " · 1h 26% · wk 7%", "the requested format");

// The same snapshot renders differently as its reset approaches: this is why the
// proxy re-renders on a timer rather than only when a fetch returns new numbers.
assert.equal(
  formatWindows(usage, { now: NOW + 40 * 60_000 }),
  " · 54m 26% · wk 7%",
  "unchanged numbers, moved clock, different label",
);

assert.equal(
  formatWindows([{ label: "5h", usedPercent: 26, resetsAt: inMinutes(29) }], { now: NOW }),
  " · 29m 26%",
  "minutes near the reset",
);
assert.equal(
  formatWindows([{ label: "5h", usedPercent: 42, resetsAt: null }], { now: NOW }),
  " · 5h 42%",
  "static fallback still renders",
);
assert.equal(formatWindows([], { now: NOW }), "", "no windows");
assert.equal(
  formatWindows([{ label: "5h", usedPercent: null, resetsAt: null }], { now: NOW }),
  "",
  "a window without a percentage is skipped",
);

// --- describeWindows: the long form for the selector's description ---------
const described = describeWindows(usage, { now: NOW });
assert.match(described, /^5h 26% until .+ · wk 7% until .+$/, `long form: ${described}`);
assert.equal(
  describeWindows([{ label: "5h", usedPercent: 42, resetsAt: null }], { now: NOW }),
  "5h 42%",
  "no reset time, no 'until'",
);
assert.equal(describeWindows([], { now: NOW }), "", "nothing to describe");

// --- maxUsedPercent decides whether the warning marker shows ---------------
assert.equal(maxUsedPercent(usage), 26, "the window closest to its cap");
assert.equal(maxUsedPercent([{ usedPercent: 5 }, { usedPercent: 94 }]), 94, "either position");
assert.equal(maxUsedPercent([{ usedPercent: null }]), null, "nothing usable");
assert.equal(maxUsedPercent([]), null, "no windows");

// --- msUntilNextReset drives the post-reset refetch ------------------------
assert.equal(msUntilNextReset(usage, NOW), 94 * 60_000, "soonest of the two");
assert.equal(msUntilNextReset([{ resetsAt: null }], NOW), null, "nothing known");
assert.equal(msUntilNextReset([], NOW), null, "no windows");

// --- labelForMinutes is untouched and still feeds the Codex provider -------
assert.equal(labelForMinutes(300), "5h");
assert.equal(labelForMinutes(10080), "wk");
assert.equal(labelForMinutes(1440), "1d");
assert.equal(labelForMinutes(45), "45m");
assert.equal(labelForMinutes(0), null);

console.log("PASS: lib/windows.mjs countdown labelling");
