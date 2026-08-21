/** Tests the JSONC editing behind `setup.mjs --write`: the entry lands in the
 *  right place, the user's comments and trailing commas survive, and nothing is
 *  reserialised. */
import assert from "node:assert/strict";
import { insertAgentServer, toStrictJson } from "../lib/jsonc.mjs";

const BLOCK = `"Claude + usage": {
  "type": "custom",
  "command": "/repo/bin/zed-agent-usage",
  "args": []
}`;

const parse = (text) => JSON.parse(toStrictJson(text));
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
};

check("strips line and block comments", () => {
  const parsed = parse(`// leading
{
  /* block */
  "a": 1 // trailing
}`);
  assert.deepEqual(parsed, { a: 1 });
});

check("strips trailing commas, including nested and before ]", () => {
  const parsed = parse(`{
  "theme": {
    "light": "One Light",
    "dark": "One Dark",
  },
  "list": [1, 2,],
}`);
  assert.deepEqual(parsed, { theme: { light: "One Light", dark: "One Dark" }, list: [1, 2] });
});

check("leaves // and commas inside strings alone", () => {
  const parsed = parse(`{
  "url": "https://zed.dev/docs", // real comment
  "csv": "a,}",
  "escaped": "quote-\\" then //not-a-comment"
}`);
  assert.equal(parsed.url, "https://zed.dev/docs");
  assert.equal(parsed.csv, "a,}");
  assert.equal(parsed.escaped, 'quote-" then //not-a-comment');
});

check("strips a comment between a trailing comma and its brace", () => {
  assert.deepEqual(parse(`{ "a": 1, // why\n}`), { a: 1 });
});

check("inserts into an existing agent_servers block", () => {
  const before = `// Zed settings
{
  "agent_servers": {
    "claude-acp": {
      "type": "registry"
    }
  },
  "theme": {
    "dark": "One Dark",
  },
}`;
  const after = insertAgentServer(before, BLOCK);
  const parsed = parse(after);

  assert.equal(parsed.agent_servers["Claude + usage"].type, "custom");
  assert.equal(parsed.agent_servers["claude-acp"].type, "registry", "existing entry kept");
  assert.equal(parsed.theme.dark, "One Dark");
  assert.ok(after.startsWith("// Zed settings"), "leading comment kept");
  assert.ok(after.includes('"One Dark",\n  },'), "trailing comma kept verbatim");
  assert.ok(after.includes('    "Claude + usage": {'), "indented to match the block");
});

check("creates agent_servers when absent", () => {
  const after = insertAgentServer(`{\n  "theme": "One Dark"\n}`, BLOCK);
  const parsed = parse(after);
  assert.equal(parsed.agent_servers["Claude + usage"].command, "/repo/bin/zed-agent-usage");
  assert.equal(parsed.theme, "One Dark");
});

check("ignores a nested key named agent_servers", () => {
  const before = `{
  "profiles": {
    "agent_servers": {
      "decoy": true
    }
  }
}`;
  const parsed = parse(insertAgentServer(before, BLOCK));
  assert.ok(parsed.agent_servers?.["Claude + usage"], "inserted at the top level");
  assert.equal(parsed.profiles.agent_servers.decoy, true, "decoy untouched");
});

check("survives an empty agent_servers block", () => {
  const parsed = parse(insertAgentServer(`{\n  "agent_servers": {}\n}`, BLOCK));
  assert.ok(parsed.agent_servers["Claude + usage"]);
});

console.log(`\nPASS: ${passed} settings checks`);
