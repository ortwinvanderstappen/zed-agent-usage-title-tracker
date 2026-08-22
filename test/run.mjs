/** Drives proxy.mjs like Zed would, against a canned adapter and a stub
 *  provider, and asserts the injected usage selector is exactly right, that the
 *  agent's own controls are untouched, and that a set-request for the injected
 *  id is answered here rather than forwarded.
 *
 *    node test/run.mjs               spawn proxy.mjs directly
 *    node test/run.mjs --launcher    spawn it the way Zed does, via bin/
 *    node test/run.mjs --countdown   stub reports reset times, so labels count down
 *    node test/run.mjs --marker      threshold lowered, so the warning marker shows
 *    node test/run.mjs --no-marker   ...and MARKER=off suppresses it again
 *    node test/run.mjs --stale       reads start failing, so the label warns
 *    node test/run.mjs --hide        a real selector is hidden from the row
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
// The stub reports 42%, so a threshold of 10 trips the marker without needing a
// second set of fixtures.
const marker = process.argv.includes("--marker");
// Same lowered threshold, but the documented off switch set: the marker must not
// appear. This is the regression test for "how do I turn it off".
const markerOff = process.argv.includes("--no-marker");
// One failed read is enough to flag it, and the stub fails every read after the
// first -- so the label is expected to pick up its "?" almost immediately.
const stale = process.argv.includes("--stale");
// Hides "model", which the canned adapter also reports, leaving "effort".
const hide = process.argv.includes("--hide");
const [command, commandArgs] = launchArgv({
  viaLauncher: process.argv.includes("--launcher"),
});
const mode = [
  countdown && "countdown",
  marker && "marker",
  markerOff && "marker-off",
  stale && "stale",
  hide && "hide",
]
  .filter(Boolean)
  .join("+");
console.log(`running: ${command} ${commandArgs.join(" ")}${mode ? ` (${mode})` : ""}`);

// 94 minutes out floors to "1h"; the weekly window stays above the 24h
// threshold and keeps its static label.
const EXPECTED =
  `${marker && !markerOff ? "🔴 " : ""}` +
  `${countdown ? "1h 42% · wk 7%" : "5h 42% · wk 7%"}` +
  `${stale ? " ?" : ""}`;

const child = spawn(command, commandArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    ZED_AGENT_USAGE_PROVIDER_PATH: path.join(here, "fake-provider.mjs"),
    ZED_AGENT_USAGE_DEBUG: "1",
    ...(countdown ? { ZED_AGENT_USAGE_FAKE_COUNTDOWN: "1" } : {}),
    ...(marker || markerOff ? { ZED_AGENT_USAGE_MARKER_AT: "10" } : {}),
    ...(markerOff ? { ZED_AGENT_USAGE_MARKER: "off" } : {}),
    ...(stale
      ? { ZED_AGENT_USAGE_FAKE_FAIL: "after-first", ZED_AGENT_USAGE_STALE_AFTER: "1" }
      : {}),
    ...(hide ? { ZED_AGENT_USAGE_HIDE: "model" } : {}),
    // Never share a snapshot with the developer's real proxies during a test.
    ZED_AGENT_USAGE_CACHE: "off",
  },
});

/** Selected value label for one option id, out of a configOptions array. */
const selectedName = (configOptions, id) => {
  const opt = (configOptions ?? []).find((o) => o.id === id);
  return (opt?.options ?? []).find((v) => v.value === opt.currentValue)?.name;
};

const usages = [];
const efforts = [];
const idSets = [];
const titles = [];
let leaked = null;
let setReply = null;
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
      idSets.push(configOptions.map((o) => o.id));
      const mine = selectedName(configOptions, "_usage");
      if (mine) usages.push(mine);
      efforts.push(selectedName(configOptions, "effort"));
    }
    if (msg.method === "test/leaked") leaked = msg.params?.configId;
    if (msg.id === 3) setReply = msg.result ?? msg.error;
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
// Clicking the injected selector: the proxy must answer this itself.
setTimeout(
  () =>
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: { sessionId: "sess_test_1", configId: "_usage", value: "current" },
    }),
  4000,
);

setTimeout(() => {
  child.kill();
  console.log(`\nusage labels:  ${JSON.stringify(usages)}`);
  console.log(`effort labels: ${JSON.stringify(efforts)}`);
  console.log(`titles:        ${JSON.stringify(titles)}`);
  console.log(`option ids:    ${JSON.stringify(idSets)}`);
  console.log(`set reply:     ${JSON.stringify(setReply)?.slice(0, 120)}`);

  if (!usages.includes(EXPECTED)) {
    console.error(`FAIL: expected an injected usage label equal to ${JSON.stringify(EXPECTED)}`);
    process.exit(1);
  }
  // Re-rendering must rebuild from the adapter's own set, not stack copies.
  const doubled = usages.find((l) => (l?.match(/%/g) ?? []).length > 2);
  if (doubled) {
    console.error(`FAIL: usage label stacked: ${doubled}`);
    process.exit(1);
  }
  // The agent's own controls must be handed through verbatim.
  if (efforts.some((l) => l !== "Xhigh")) {
    console.error(`FAIL: a real selector was modified: ${JSON.stringify(efforts)}`);
    process.exit(1);
  }
  // Hiding removes only the named option, and never ours.
  if (hide && idSets.some((ids) => ids.includes("model"))) {
    console.error(`FAIL: hidden option still present: ${JSON.stringify(idSets)}`);
    process.exit(1);
  }
  if (idSets.some((ids) => !ids.includes("effort") || !ids.includes("_usage"))) {
    console.error(`FAIL: a kept option went missing: ${JSON.stringify(idSets)}`);
    process.exit(1);
  }
  // The set-request for our id must never reach the agent.
  if (leaked) {
    console.error(`FAIL: set_config_option for ${leaked} was forwarded to the agent`);
    process.exit(1);
  }
  if (!setReply?.configOptions?.some((o) => o.id === "_usage")) {
    console.error(`FAIL: set_config_option was not answered with the option set`);
    process.exit(1);
  }
  // Titles are relayed verbatim now that the title surface is gone.
  if (titles.some((t) => t !== "Fix auth bug")) {
    console.error(`FAIL: title was modified: ${JSON.stringify(titles)}`);
    process.exit(1);
  }
  console.log(`PASS: Usage "${EXPECTED}" injected; real controls, title and set-request all clean`);
  process.exit(0);
}, 9000);
