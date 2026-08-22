/** Window labelling, shared by the providers and the proxy.
 *
 *  A window is { label: "5h", usedPercent: 16, resetsAt: <epoch s | ISO | null> }.
 *  `label` is the fallback when no reset time is known; otherwise the rendered
 *  label counts down to the reset -- "5h 26%" becomes "1h 26%", which is what a
 *  reader actually wants. The panel is narrow, so keep it brief.
 */

/** Above this, keep the static label -- "wk 7%" beats "6d 7%" at a glance.
 *  Below it, even the weekly window counts down. */
const COUNTDOWN_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Short label for a window of a given length, for providers that report
 *  durations rather than names (Codex). */
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

/** Milliseconds until `resetsAt`, or null if absent or unparseable. Accepts an
 *  ISO string or epoch seconds. */
export function msUntil(resetsAt, now = Date.now()) {
  if (resetsAt == null) return null;
  let at;
  if (typeof resetsAt === "number") {
    if (!Number.isFinite(resetsAt)) return null;
    // 1e11 is year 5138 in seconds but 1973 in millis, so below it means seconds.
    at = resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
  } else {
    at = Date.parse(resetsAt);
    if (Number.isNaN(at)) return null;
  }
  return at - now;
}

/** Time remaining as one floored unit: "29m", "1h", "6d". Floored, so it never
 *  promises a reset that has not arrived. */
export function countdownLabel(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Countdown when the reset is known and near, else the static label. */
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

/** Highest utilisation across the windows -- whichever will bite first. */
export function maxUsedPercent(windows) {
  const values = (windows ?? [])
    .map((w) => w?.usedPercent)
    .filter((v) => typeof v === "number");
  return values.length ? Math.max(...values) : null;
}

/** Long form for the selector's description, where absolute reset times fit:
 *  "5h 26% until Fri 19:10 · wk 7% until Thu 21:00". Local time on purpose. */
export function describeWindows(windows, { now = Date.now() } = {}) {
  const parts = (windows ?? [])
    .filter((w) => w && typeof w.usedPercent === "number")
    .map((w) => {
      const label = w.label ?? windowLabel(w, now) ?? "?";
      const text = `${label} ${Math.round(w.usedPercent)}%`;
      const remaining = msUntil(w.resetsAt, now);
      if (remaining == null) return text;
      const when = new Date(now + remaining).toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${text} until ${when}`;
    });
  return parts.join(" · ");
}

/** Time until the soonest reset, so the proxy can re-read once it rolls over. */
export function msUntilNextReset(windows, now = Date.now()) {
  const times = (windows ?? [])
    .map((w) => msUntil(w?.resetsAt, now))
    .filter((ms) => ms != null);
  return times.length ? Math.min(...times) : null;
}
