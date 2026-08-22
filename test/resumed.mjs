/** A resumed thread must keep receiving usage updates.
 *
 *  Zed reopens a thread with `session/load`, whose response carries no
 *  sessionId -- it is only in the request. Attributing the response to the wrong
 *  session (or to none) leaves that thread's label frozen at whatever the usage
 *  was when it loaded, while freshly created threads keep ticking. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESUMED = "sess_resumed";

const child = spawn(process.execPath, [path.join(here, "..", "proxy.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
    ZED_AGENT_USAGE_FAKE_COUNTDOWN: "1",
    // Five seconds past the hour boundary, so "1h" becomes "59m" almost at once
    // and the label has a reason to be republished.
    ZED_AGENT_USAGE_FAKE_RESET_SECONDS: "3605",
    ZED_AGENT_USAGE_RENDER_MS: "1000",
    ZED_AGENT_USAGE_CACHE: "off",
  },
});

const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const labels = [];
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
    const update = msg.params?.update;
    const opts = msg.result?.configOptions ?? update?.configOptions;
    if (!opts || (update && msg.params.sessionId !== RESUMED)) continue;
    const mine = opts.find((o) => o.id === "_usage");
    const name = (mine?.options ?? []).find((v) => v.value === mine.currentValue)?.name;
    if (name) labels.push(name);
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
setTimeout(
  () =>
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: { sessionId: RESUMED, cwd: process.cwd(), mcpServers: [] },
    }),
  200,
);

setTimeout(() => {
  child.kill();
  console.log(`labels for the resumed session: ${JSON.stringify(labels)}`);
  if (labels.length < 2) {
    console.error("FAIL: the resumed session stopped being updated");
    process.exit(1);
  }
  if (new Set(labels).size < 2) {
    console.error(`FAIL: the label never changed: ${JSON.stringify(labels)}`);
    process.exit(1);
  }
  console.log(`PASS: resumed session tracked ${labels[0]} -> ${labels.at(-1)}`);
  process.exit(0);
}, 12000);
