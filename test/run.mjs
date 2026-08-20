/** Drives proxy.mjs like Zed would, against a canned adapter and a stub
 *  provider, and asserts the thread title is decorated exactly. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const proxy = path.join(here, "..", "proxy.mjs");

const EXPECTED = "Fix auth bug · 5h 42% · wk 7%";

const child = spawn(process.execPath, [proxy], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    CLAUDE_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
    CLAUDE_USAGE_DEBUG: "1",
  },
});

const titles = [];
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    console.log(`<- ${line}`);
    const update = msg?.params?.update;
    if (update?.sessionUpdate === "session_info_update" && "title" in update) {
      titles.push(update.title);
    }
  }
});

const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
setTimeout(
  () => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } }),
  100,
);

setTimeout(() => {
  child.kill();
  console.log(`\ntitles seen: ${JSON.stringify(titles)}`);
  if (!titles.includes(EXPECTED)) {
    console.error(`FAIL: expected a title equal to ${JSON.stringify(EXPECTED)}`);
    process.exit(1);
  }
  // Re-decoration must not stack suffixes.
  const doubled = titles.find((t) => (t?.match(/5h \d+%/g) ?? []).length > 1);
  if (doubled) {
    console.error(`FAIL: suffix applied twice: ${doubled}`);
    process.exit(1);
  }
  console.log(`PASS: ${EXPECTED}`);
  process.exit(0);
}, 8000);
