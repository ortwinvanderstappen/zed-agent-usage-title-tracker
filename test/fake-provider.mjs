/** Provider stub for the proxy test: fixed windows and a canned adapter, so the
 *  test is deterministic and touches no account. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

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
        { label: "5h", usedPercent: 42, resetsAt: null },
        { label: "wk", usedPercent: 7, resetsAt: null },
      ],
    };
  },
};
