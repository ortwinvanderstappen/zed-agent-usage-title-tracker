/** Drives proxy.mjs against a real ACP adapter.
 *
 *   node test/real.mjs                  claude, handshake only -- no model call
 *   node test/real.mjs codex            codex, handshake only
 *   PROMPT="hi" node test/real.mjs      also sends one short turn (uses quota)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const proxy = path.join(here, "..", "proxy.mjs");
const prompt = process.env.PROMPT;
const provider = process.argv[2] ?? "claude";

const child = spawn(process.execPath, [proxy, "--provider", provider], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CLAUDE_USAGE_DEBUG: "1" },
});

const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const titles = [];
let sessionId = null;
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`<- (raw) ${line}`);
      continue;
    }

    const update = msg?.params?.update;
    if (update?.sessionUpdate === "session_info_update" && "title" in update) {
      titles.push(update.title);
      console.log(`<- TITLE ${JSON.stringify(update.title)}`);
    } else if (msg.id === 1) {
      console.log(`<- initialize ok: ${JSON.stringify(msg.result ?? msg.error).slice(0, 160)}`);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      });
    } else if (msg.id === 2) {
      sessionId = msg.result?.sessionId ?? null;
      console.log(`<- session/new: ${sessionId ?? JSON.stringify(msg.error)}`);
      if (sessionId && prompt) {
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: prompt }] },
        });
      }
    } else if (msg.id === 3) {
      console.log(`<- prompt settled: ${JSON.stringify(msg.result ?? msg.error).slice(0, 200)}`);
    } else if (update?.sessionUpdate) {
      console.log(`<- ${update.sessionUpdate}`);
    }

    // Client-side requests the agent may make during a turn.
    if (msg.method === "session/request_permission") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: msg.params?.options?.[0]?.optionId } },
      });
    }
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  },
});

setTimeout(() => {
  child.kill();
  console.log(`\ntitles: ${JSON.stringify(titles)}`);
  const decorated = titles.filter((t) => /[0-9a-z]{1,5} \d+%/.test(t ?? ""));
  console.log(decorated.length ? `PASS: ${decorated.at(-1)}` : "no decorated title (see notes)");
  process.exit(decorated.length || !prompt ? 0 : 1);
}, prompt ? 90_000 : 25_000);
