/** Drives proxy.mjs against a real ACP adapter.
 *
 *   node test/real.mjs                  claude, handshake only -- no model call
 *   node test/real.mjs codex            codex, handshake only
 *   node test/real.mjs --launcher       start it exactly as Zed is configured to
 *   PROMPT="hi" node test/real.mjs      also sends one short turn (uses quota)
 */
import { spawn } from "node:child_process";
import { launchArgv } from "./launch.mjs";

const prompt = process.env.PROMPT;
const viaLauncher = process.argv.includes("--launcher");
const provider = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "claude";

const [command, commandArgs] = launchArgv({
  viaLauncher,
  extra: ["--provider", provider],
});
console.log(`running: ${command} ${commandArgs.join(" ")}`);

const child = spawn(command, commandArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ZED_AGENT_USAGE_DEBUG: "1" },
});

const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const labels = [];
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
    // The decorated selector arrives either on the session/new response or on a
    // later config_option_update, depending on whether the first usage fetch
    // has landed yet -- record both.
    const configOptions = msg.result?.configOptions ?? update?.configOptions;
    if (configOptions) {
      for (const opt of configOptions) {
        const cur = (opt.options ?? []).find((v) => v.value === opt.currentValue);
        if (cur?.name && /\d+%/.test(cur.name)) {
          labels.push(`${opt.id} (${opt.name}): ${cur.name}`);
          console.log(`<- SELECTOR ${opt.id} "${opt.name}" = ${JSON.stringify(cur.name)}`);
          if (opt.description) console.log(`   description: ${opt.description}`);
        }
      }
    }
    if (msg.id === 1) {
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
  console.log(`\ndecorated selectors: ${JSON.stringify(labels)}`);
  if (!labels.length) {
    console.error("FAIL: no selector carried the usage");
    process.exit(1);
  }
  console.log(`PASS: ${labels.at(-1)}`);
  process.exit(0);
}, prompt ? 90_000 : 25_000);
