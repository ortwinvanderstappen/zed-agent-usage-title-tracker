/** The last-activity selector: when was this thread last worked in.
 *
 *  The point of it is surviving a reopen, so that is what this asserts — Zed
 *  does not store external-agent threads, so the value has to come from our own
 *  record, in a process that did not see the original turn. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Own cache dir, so this never touches the developer's real activity record.
const cacheDir = mkdtempSync(path.join(tmpdir(), "zed-agent-usage-test-"));

/** Run one proxy, drive it, and report the injected selectors it emitted. */
function run(drive, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "..", "proxy.mjs")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
        ZED_AGENT_USAGE_CACHE_DIR: cacheDir,
        ZED_AGENT_USAGE_CACHE: "off", // don't share usage snapshots between passes
        ...extraEnv,
      },
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const found = new Map();
    let buf = "";
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
        for (const o of opts ?? []) {
          if (!o.id?.startsWith("_")) continue;
          const name = (o.options ?? []).find((v) => v.value === o.currentValue)?.name;
          if (name) found.set(o.id, name);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    setTimeout(() => drive(send), 300);
    setTimeout(() => {
      child.kill();
      resolve(found);
    }, 6000);
  });
}

const newSession = (send) =>
  send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } });
const reopen = (send) =>
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/load",
    params: { sessionId: "sess_test_1", cwd: process.cwd(), mcpServers: [] },
  });

try {
  // A turn happens (the stub adapter emits usage_update), so activity is recorded.
  const first = await run(newSession);
  console.log(`new session: ${JSON.stringify(Object.fromEntries(first))}`);
  const stamp = first.get("_lastActivity");
  assert.ok(stamp, "expected a _lastActivity selector after a turn");
  assert.match(stamp, /\d/, `expected a date and time, got ${JSON.stringify(stamp)}`);

  // Reopened in a fresh process: Zed stored nothing, so this proves persistence.
  const second = await run(reopen);
  console.log(`reopened:    ${JSON.stringify(Object.fromEntries(second))}`);
  assert.equal(
    second.get("_lastActivity"),
    stamp,
    "the timestamp must survive reopening in a new process",
  );

  // Opt out.
  const disabled = await run(reopen, { ZED_AGENT_USAGE_LAST_ACTIVITY: "off" });
  console.log(`disabled:    ${JSON.stringify(Object.fromEntries(disabled))}`);
  assert.equal(disabled.get("_lastActivity"), undefined, "off must suppress it");
  assert.ok(disabled.get("_usage"), "usage must still be shown when it is off");

  console.log(`PASS: last activity "${stamp}" survives a reopen and can be turned off`);
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
