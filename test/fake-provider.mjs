/** Provider stub for the proxy test: fixed windows and a canned adapter, so the
 *  test is deterministic and touches no account.
 *
 *  With ZED_AGENT_USAGE_FAKE_COUNTDOWN=1 the windows carry reset times instead
 *  of nulls, which exercises the countdown labels end to end. Offsets are
 *  chosen to sit well inside their unit so the assertion cannot flake as the
 *  clock moves during the test: 94 minutes floors to "1h" for another 34
 *  minutes, and 6 days stays above the 24h countdown threshold.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const countdown = process.env.ZED_AGENT_USAGE_FAKE_COUNTDOWN === "1";
/** Seconds until the rolling window resets. Overridable so a test can park the
 *  clock just past a unit boundary and watch the label tick over. */
const rollingSeconds = Number(process.env.ZED_AGENT_USAGE_FAKE_RESET_SECONDS ?? 94 * 60);
const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();
const inMinutes = (m) => inSeconds(m * 60);

export default {
  id: "fake",
  displayName: "Fake",
  resolveAdapter() {
    return { command: process.execPath, args: [path.join(here, "fake-adapter.mjs")] };
  },
  async fetchUsage() {
    return {
      available: true,
      planType: "test",
      windows: [
        { label: "5h", usedPercent: 42, resetsAt: countdown ? inSeconds(rollingSeconds) : null },
        { label: "wk", usedPercent: 7, resetsAt: countdown ? inMinutes(6 * 24 * 60) : null },
      ],
    };
  },
};
