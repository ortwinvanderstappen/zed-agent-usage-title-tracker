/** Three behaviours that only show up over time:
 *
 *  - an idle window stops fetching entirely
 *  - a window with work in progress keeps its figures inside MAX_AGE
 *  - once reads start failing, the label admits it
 *
 *  Timings are compressed via the env knobs so this runs in seconds. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Run a proxy for `ms`, returning what it fetched and what the label became. */
function run({ ms, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "..", "proxy.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
        ZED_AGENT_USAGE_DEBUG: "1",
        ZED_AGENT_USAGE_CACHE: "off", // never share with the developer's real proxies
        ZED_AGENT_USAGE_RENDER_MS: "500",
        ZED_AGENT_USAGE_MIN_AGE_MS: "0",
        ZED_AGENT_USAGE_MAX_AGE_MS: "2000",
        ...env,
      },
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const labels = [];
    let fetches = 0;
    let buf = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      for (const line of d.split("\n")) if (line.includes("(fetched)")) fetches += 1;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const opts = msg.result?.configOptions ?? msg.params?.update?.configOptions;
        const mine = (opts ?? []).find((o) => o.id === "_usage");
        const name = (mine?.options ?? []).find((v) => v.value === mine.currentValue)?.name;
        if (name && name !== labels.at(-1)) labels.push(name);
      }
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    setTimeout(
      () => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } }),
      300,
    );
    setTimeout(() => {
      child.kill();
      resolve({ fetches, labels });
    }, ms);
  });
}

// --- idle: the safety net must not fire, even with MAX_AGE at 2s ----------
const idle = await run({ ms: 9000, env: { ZED_AGENT_USAGE_IDLE_AFTER_MS: "1" } });
console.log(`idle:   ${idle.fetches} fetches, labels ${JSON.stringify(idle.labels)}`);
// startup, plus the stub adapter's one usage_update at session start.
assert.ok(idle.fetches <= 2, `an idle window kept fetching (${idle.fetches})`);
assert.ok(
  idle.labels.every((l) => !l.includes("?")),
  "idling on purpose must not be reported as stale",
);

// --- working: keeps refreshing --------------------------------------------
const busy = await run({ ms: 9000, env: { ZED_AGENT_USAGE_IDLE_AFTER_MS: "600000" } });
console.log(`active: ${busy.fetches} fetches`);
assert.ok(busy.fetches > idle.fetches, "a working window should refresh more than an idle one");

// --- failing reads: the label says so -------------------------------------
const failing = await run({ ms: 9000, env: { ZED_AGENT_USAGE_FAKE_FAIL: "after-first" } });
console.log(`failing: labels ${JSON.stringify(failing.labels)}`);
assert.ok(failing.labels.length >= 2, "expected the label to change once reads failed");
assert.ok(!failing.labels[0].includes("?"), "the first, good read is not stale");
assert.ok(failing.labels.at(-1).endsWith(" ?"), "failing reads must be admitted");

console.log("PASS: idle stops fetching, work resumes it, failures are admitted");
