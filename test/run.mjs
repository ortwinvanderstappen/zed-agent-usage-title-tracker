/** Drives proxy.mjs like Zed would, against a canned adapter and a stub
 *  provider, and asserts the config selector is decorated exactly.
 *
 *    node test/run.mjs               spawn proxy.mjs directly
 *    node test/run.mjs --launcher    spawn it the way Zed does, via bin/
 *    node test/run.mjs --countdown   stub reports reset times, so labels count down
 *
 *  The launcher pass matters because that is what settings.json points at, and
 *  it is a different file per platform. The countdown pass covers the labels a
 *  real provider produces; without it the stub reports no reset times and the
 *  static fallback labels are what get asserted.
 *
 *  Note the session/new response deliberately races the first usage fetch, which
 *  is what happens in Zed: the decoration has to arrive via a later republish. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchArgv } from "./launch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const countdown = process.argv.includes("--countdown");
const [command, commandArgs] = launchArgv({
  viaLauncher: process.argv.includes("--launcher"),
});
console.log(`running: ${command} ${commandArgs.join(" ")}${countdown ? " (countdown)" : ""}`);

// 94 minutes out floors to "1h"; the weekly window stays above the 24h
// threshold and keeps its static label.
const EXPECTED = countdown ? "Xhigh · 1h 42% · wk 7%" : "Xhigh · 5h 42% · wk 7%";

const child = spawn(command, commandArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
    ZED_AGENT_USAGE_DEBUG: "1",
    ...(countdown ? { ZED_AGENT_USAGE_FAKE_COUNTDOWN: "1" } : {}),
  },
});

/** Selected value label for one option id, out of a configOptions array. */
const selectedName = (configOptions, id) => {
  const opt = (configOptions ?? []).find((o) => o.id === id);
  return (opt?.options ?? []).find((v) => v.value === opt.currentValue)?.name;
};

const efforts = [];
const models = [];
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
    console.log(`<- ${line.slice(0, 240)}`);

    const configOptions = msg.result?.configOptions ?? msg.params?.update?.configOptions;
    if (configOptions) {
      efforts.push(selectedName(configOptions, "effort"));
      models.push(selectedName(configOptions, "model"));
    }
    const update = msg.params?.update;
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
  console.log(`\neffort labels: ${JSON.stringify(efforts)}`);
  console.log(`model labels:  ${JSON.stringify(models)}`);
  console.log(`titles:        ${JSON.stringify(titles)}`);

  if (!efforts.includes(EXPECTED)) {
    console.error(`FAIL: expected an effort label equal to ${JSON.stringify(EXPECTED)}`);
    process.exit(1);
  }
  // Re-rendering must rebuild from the adapter's own set, not append twice.
  const doubled = efforts.find((l) => (l?.match(/%/g) ?? []).length > 2);
  if (doubled) {
    console.error(`FAIL: suffix applied twice: ${doubled}`);
    process.exit(1);
  }
  // Only the nominated selector is touched.
  if (models.some((l) => l !== "Sonnet")) {
    console.error(`FAIL: a control selector was modified: ${JSON.stringify(models)}`);
    process.exit(1);
  }
  // Titles are relayed verbatim now that the title surface is gone.
  if (titles.some((t) => t !== "Fix auth bug")) {
    console.error(`FAIL: title was modified: ${JSON.stringify(titles)}`);
    process.exit(1);
  }
  console.log(`PASS: ${EXPECTED} (title and control selector untouched)`);
  process.exit(0);
}, 8000);
