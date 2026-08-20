/** Helpers shared by usage providers and the proxy.
 *
 *  A provider reports usage as a list of windows:
 *    { label: "5h", usedPercent: 16, resetsAt: <epoch seconds | ISO string | null> }
 *
 *  `label` is what the thread title shows, so keep it short.
 */

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

/** " · 5h 16% · wk 62%", or "" when there is nothing to show. */
export function formatWindows(windows) {
  const parts = (windows ?? [])
    .filter((w) => w && w.label && typeof w.usedPercent === "number")
    .map((w) => `${w.label} ${Math.round(w.usedPercent)}%`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** Matches a suffix this tool previously appended, so titles can be re-decorated
 *  without accumulating copies. Deliberately loose about labels and count. */
export const SUFFIX_RE = /\s·\s(?:[0-9a-z]{1,5}\s\d+%)(?:\s·\s[0-9a-z]{1,5}\s\d+%)*$/;

/** True when the two snapshots would render identically. */
export function sameWindows(a, b) {
  return formatWindows(a) === formatWindows(b);
}
