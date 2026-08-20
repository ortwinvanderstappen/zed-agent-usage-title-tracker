# claude-usage

Shows your agent plan usage — rolling window and weekly — in the Zed agent thread
title.

```
Fix auth bug · 5h 16% · wk 62%
```

Ships with providers for **Claude Code** and **Codex**, and is modular so other
ACP agents can be added by dropping in one file — see
[providers/README.md](providers/README.md).

## Why this isn't a Zed extension

Zed extensions can provide languages, debuggers, themes, icon themes, snippets
and MCP servers. The `Extension` trait has no UI surface at all — no panel,
status bar or agent-thread rendering. So a usage badge cannot be drawn by an
extension.

Instead this is a **stdio proxy** that sits in the ACP connection:

```
Zed  <--stdio-->  proxy.mjs  <--stdio-->  <agent>-acp adapter
```

Zed renders `session_info_update.title`, so the proxy appends the percentages to
whatever title the adapter reports and relays everything else untouched. The
decorated title shows up wherever Zed renders a thread title, including the agent
panel's thread list.

## Setup

There is nothing to install — the proxy reuses the adapters and binaries Zed
already downloaded for `claude-acp` / `codex-acp`, so versions stay matched to
Zed's.

1. Find your node binary and this repo's path:

   ```sh
   which node && pwd
   ```

2. Add one entry per agent to `~/.config/zed/settings.json`, inside
   `agent_servers`:

   ```json
   "agent_servers": {
     "Claude + usage": {
       "type": "custom",
       "command": "/usr/local/bin/node",
       "args": ["/path/to/claude-usage/proxy.mjs"]
     },
     "Codex + usage": {
       "type": "custom",
       "command": "/usr/local/bin/node",
       "args": ["/path/to/claude-usage/proxy.mjs", "--provider", "codex"]
     }
   }
   ```

   `command` must be an **absolute** path — Zed launched from the Finder does not
   inherit your shell `PATH`, so a bare `"node"` fails to spawn. Omitting
   `--provider` defaults to `claude`.

3. In Zed's agent panel, open the agent picker and choose **Claude + usage** or
   **Codex + usage**. Settings are picked up without a restart.

Existing `claude-acp` / `codex-acp` entries keep working — leave them in place to
switch back at any time.

### Or have an agent do it

Paste this into Claude Code (or the Zed agent panel), replacing the path on the
first line:

````text
Set up the claude-usage ACP proxy in my Zed settings.

The repo is checked out at: <PATH TO THIS REPO>

Please:
1. Resolve the absolute path to my node binary with `which node`. Zed launched
   from the Finder does not inherit my shell PATH, so a bare "node" will not work.
2. Back up ~/.config/zed/settings.json, then add these entries inside the existing
   "agent_servers" object, creating that object if it is missing. The file is
   JSONC, not strict JSON — preserve its existing comments, trailing commas and
   formatting rather than reserialising it:

     "Claude + usage": {
       "type": "custom",
       "command": "<absolute node path>",
       "args": ["<repo path>/proxy.mjs"]
     },
     "Codex + usage": {
       "type": "custom",
       "command": "<absolute node path>",
       "args": ["<repo path>/proxy.mjs", "--provider", "codex"]
     }

3. Leave any existing "claude-acp" and "codex-acp" entries untouched so I can
   switch back.
4. Verify the file still parses (strip // comments and trailing commas before
   parsing), then run `node <repo path>/usage.mjs` and
   `node <repo path>/usage.mjs codex` and report the percentages each prints.
5. Tell me to pick "Claude + usage" or "Codex + usage" in Zed's agent panel picker.
````

## Layout

```
proxy.mjs             generic ACP relay + title injection
usage.mjs             CLI: print a provider's snapshot
providers/claude.mjs  Claude Code: Agent SDK get_usage control request
providers/codex.mjs   Codex: codex app-server account/rateLimits/read
providers/index.mjs   filename-based provider discovery
lib/windows.mjs       window labelling and suffix formatting
lib/resolve.mjs       locating binaries Zed already installed
```

## Where the numbers come from

Neither provider handles credentials and neither makes a model call, so no quota
is consumed. Both delegate authentication to a subprocess that already does it.

**Claude** — the Agent SDK's `get_usage` control request
(`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`), which returns the
data behind `/usage`: utilization 0–100 per window plus reset times. Note the
name carries an explicit instability warning; if it is renamed upstream,
`providers/claude.mjs` is the only place to update.

**Codex** — `codex app-server` over newline-delimited JSON-RPC:
`initialize`, then `account/rateLimits/read`. Codex reports windows by duration
(`windowDurationMins`) rather than by name, and which windows exist depends on
the plan: a Plus account may report only the weekly window with `secondary: null`,
so you may see just `wk 0%`. Labels are derived from the duration, so a plan that
reports a 5-hour window gets `5h` with no code change.

Refreshed at startup, on every `usage_update` from the adapter (turn end,
rate-limited to one fetch per 15s), and every 60s.

### What does *not* work, and why

- **Claude's ACP rate-limit meta.** The adapter attaches
  `_meta["_claude/rateLimit"]` to `usage_update`
  (`claude-agent-acp/dist/acp-agent.js:3344`), but Zed ignores it — there is no
  `_claude/` key anywhere in the Zed binary. More fundamentally it carries a
  `utilization` figure **only once a warning threshold is crossed** (5h ≥ 90%,
  7d ≥ 75%). Below that the payload is `{status:"allowed", resetsAt,
  rateLimitType}` with no percentage: in the CLI bundle the normal path (`aQ9`)
  omits `utilization`, which is populated only by the surpassed-threshold
  branches (`qH5`/`KH5`).
- **Codex's ACP stream.** The codex-acp bundle contains zero rate-limit strings —
  it drops `TokenCountEvent.rate_limits` entirely, so there is nothing to sniff.
- **Local transcripts.** `~/.claude/projects/*.jsonl` holds token counts, not
  plan-limit percentages. Checked 55 transcripts: zero occurrences of
  `rateLimitType`, `utilization` or `used_percentage`.
- **statusLine.** It does expose both Claude windows
  (`rate_limits.five_hour.used_percentage`), but statusLine is a terminal feature
  and is not executed on the ACP/SDK path.

## Behaviour notes

- Until the adapter reports a title (both adapters generate one — Claude at turn
  end, Codex from `thread/name/updated` or the first user message), the thread
  title is just the percentages; the real title is prepended once it arrives.
- Re-decoration strips a previously appended suffix, so titles never stack.
- For Claude, weekly prefers the all-models window, falling back to the highest
  per-model window so the figure shown is always the binding one.
- When plan limits don't apply (API key, Bedrock, Vertex), nothing is appended.

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_USAGE_PROVIDER` | `claude` | Provider id, if `--provider` is not passed |
| `CLAUDE_USAGE_PROVIDER_PATH` | – | Absolute path to an out-of-tree provider |
| `CLAUDE_USAGE_REFRESH_MS` | `60000` | Background refresh interval |
| `CLAUDE_USAGE_MIN_INTERVAL_MS` | `15000` | Minimum gap between fetches |
| `CLAUDE_USAGE_DEBUG` | – | `1` logs to stderr (Zed: `dev: open acp logs`) |
| `CLAUDE_USAGE_ADAPTER_COMMAND` / `_ARGS` | auto | Override the wrapped adapter |
| `CLAUDE_AGENT_SDK` | auto | Override the Claude SDK `sdk.mjs` path |
| `CODEX_BIN` | auto | Override the `codex` binary path |

## Tests

```sh
npm test                    # proxy + canned adapter + stub provider; asserts the exact title
npm run usage               # print the Claude snapshot
npm run usage:codex         # print the Codex snapshot
npm run test:real           # proxy against the real claude-acp (handshake only)
npm run test:real:codex     # proxy against the real codex-acp (handshake only)
PROMPT=hi npm run test:real # also runs one short turn (uses quota)
```

## Upstream

Zed discussion [#54792](https://github.com/zed-industries/zed/discussions/54792)
requests this as a native, opt-in agent-panel indicator. The proper fix is a Zed
change; this proxy needs no Zed patch.

## License

[MIT](LICENSE) — free to use, modify and redistribute.

Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI or Zed
Industries. "Claude", "Codex" and "Zed" are trademarks of their respective
owners; this project merely interoperates with their tools. It relies on
interfaces that are internal or explicitly marked experimental, so it may break
on any upstream release.
