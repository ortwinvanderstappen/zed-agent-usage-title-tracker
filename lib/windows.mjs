/** Helpers shared by usage providers and the proxy.
 *
 *  A provider reports usage as a list of windows:
 *    { label: "5h", usedPercent: 16, resetsAt: <epoch seconds | ISO string | null> }
 *
 *  `label` is the static fallback shown when a reset time is unknown, so keep it
 *  short. When a reset time IS known and close enough to be useful, the rendered
 *  label counts down to it instead -- "5h 26%" (a window five hours long) becomes
 *  "1h 26%" (a window resetting in an hour), which is what a reader actually
 *  wants to know.
 */

/** Above this much time remaining, a window keeps its static label: "6d 7%"
 *  says less at a glance than "wk 7%". Below it, the countdown takes over, so a
 *  weekly window still tells you when relief arrives on its final day. */
const COUNTDOWN_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Conventional short label for a rolling window of a given length. Providers
 *  that report window durations rather than names (Codex) use this so a new
 *  window length gets a sensible label without a code change. */
export function labelForMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? "wk" : `${weeks}wk`;
  }
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Milliseconds until `resetsAt`, or null when it is absent or unparseable.
 *  Accepts the two shapes providers produce: an ISO 8601 string, or epoch
 *  seconds (distinguished from epoch millis by magnitude). */
export function msUntil(resetsAt, now = Date.now()) {
  if (resetsAt == null) return null;
  let at;
  if (typeof resetsAt === "number") {
    if (!Number.isFinite(resetsAt)) return null;
    // Epoch seconds until ~1e11, which is the year 5138 in seconds but only
    // 1973 in millis -- anything smaller is seconds.
    at = resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
  } else {
    at = Date.parse(resetsAt);
    if (Number.isNaN(at)) return null;
  }
  return at - now;
}

/** Time remaining as a single floored unit: "29m", "1h", "6d".
 *  1h20m reads as "1h" -- the coarser unit is the honest one, since rounding up
 *  would promise a reset that has not arrived. */
export function countdownLabel(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The label to render for one window: a countdown when the reset is known and
 *  near, otherwise the provider's static label. */
export function windowLabel(window, now = Date.now()) {
  const remaining = msUntil(window?.resetsAt, now);
  if (remaining != null && remaining < COUNTDOWN_THRESHOLD_MS) {
    return countdownLabel(remaining);
  }
  return window?.label ?? null;
}

/** " · 1h 26% · wk 7%", or "" when there is nothing to show. */
export function formatWindows(windows, { now = Date.now() } = {}) {
  const parts = (windows ?? [])
    .filter((w) => w && typeof w.usedPercent === "number")
    .map((w) => {
      const label = windowLabel(w, now);
      return label ? `${label} ${Math.round(w.usedPercent)}%` : null;
    })
    .filter(Boolean);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** Matches a suffix this tool previously appended, so titles can be re-decorated
 *  without accumulating copies. Deliberately loose about labels and count. */
export const SUFFIX_RE = /\s·\s(?:[0-9a-z]{1,5}\s\d+%)(?:\s·\s[0-9a-z]{1,5}\s\d+%)*$/;

/** True when the two snapshots would render identically at the same instant. */
export function sameWindows(a, b, { now = Date.now() } = {}) {
  return formatWindows(a, { now }) === formatWindows(b, { now });
}

/** When the soonest known reset falls due, in ms, or null if none is known.
 *  The proxy uses this to re-read usage once a window has rolled over, since a
 *  cached percentage from before a reset is stale. */
export function msUntilNextReset(windows, now = Date.now()) {
  const times = (windows ?? [])
    .map((w) => msUntil(w?.resetsAt, now))
    .filter((ms) => ms != null);
  return times.length ? Math.min(...times) : null;
}
