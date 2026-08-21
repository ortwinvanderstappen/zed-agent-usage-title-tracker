# zed-agent-usage-title-tracker

Shows your agent plan usage — rolling window and weekly — in the Zed agent thread
title, labelled by how long until each window resets.

```
Hello, world! · 1h 16% · wk 62%
```

<img width="411" height="200" alt="2026-08-20_23-17-11" src="https://github.com/user-attachments/assets/48a78fa0-cb32-4372-ab33-e3ca1de7c57f" />


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

There is nothing to install — the proxy has no dependencies, and it reuses the
adapters and binaries Zed already downloaded for `claude-acp` / `codex-acp`, so
versions stay matched to Zed's. You do not need your own node either: Zed ships
one, and the launcher finds it.

```sh
node setup.mjs            # print the entry for this machine, and where it goes
node setup.mjs --write    # add it, backing settings.json up first
```

`setup.mjs` resolves every path itself, which is the point — they all differ per
platform. Then pick **Claude + usage** in Zed's agent panel picker; settings are
picked up without a restart.

For Codex, `node setup.mjs --provider codex --write` adds a **Codex + usage**
entry alongside it.

Existing `claude-acp` / `codex-acp` entries keep working — leave them in place to
switch back at any time.

### What it writes

macOS and Linux point straight at the launcher:

```json
"agent_servers": {
  "Claude + usage": {
    "type": "custom",
    "command": "/path/to/zed-agent-usage-title-tracker/bin/zed-agent-usage",
    "args": []
  }
}
```

Windows goes through `cmd.exe`:

```json
"agent_servers": {
  "Claude + usage": {
    "type": "custom",
    "command": "C:/Windows/System32/cmd.exe",
    "args": ["/c", "D:/path/to/zed-agent-usage-title-tracker/bin/zed-agent-usage.cmd"]
  }
}
```

The launcher resolves node at run time instead of settings.json storing a path,
which sidesteps two problems at once. A GUI-launched Zed does not inherit your
shell `PATH`, so a bare `"node"` fails to spawn — that is why this used to want
`which node`. And Zed's own node lives in a version-stamped directory that is
replaced when Zed upgrades it, so an absolute path written into settings goes
stale. The launcher checks `ZED_AGENT_USAGE_NODE`, then Zed's node, then `PATH`.

### macOS, Linux and Windows differences

Only three things differ, and `setup.mjs` handles all of them:

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| `settings.json` | `~/.config/zed/settings.json` | same | `%APPDATA%\Zed\settings.json` |
| Zed support dir | `~/Library/Application Support/Zed` | `~/.local/share/zed` | `%LOCALAPPDATA%\Zed` |
| launcher | `bin/zed-agent-usage` | same | `bin\zed-agent-usage.cmd`, via `cmd.exe /c` |

Note that on Windows those are two different roots: settings live under
`%APPDATA%`, while downloaded agents and node live under `%LOCALAPPDATA%`. The
Windows entry goes through `cmd.exe` because a batch file is not universally
spawnable — node refuses outright since the CVE-2024-27980 mitigation — whereas
`cmd.exe` is a real executable at a path that never moves.

### Or have an agent do it

Paste this into Claude Code (or the Zed agent panel), replacing the path on the
first line:

````text
Set up the zed-agent-usage-title-tracker ACP proxy in my Zed settings.

The repo is checked out at: <PATH TO THIS REPO>

Please:
1. Run `node setup.mjs` in that directory and show me what it reports. It
   resolves my platform's paths itself — do not hand-write any of them.
2. Run `node setup.mjs --write` to add the entry. It backs settings.json up
   first, preserves the file's comments and trailing commas, and leaves any
   existing "claude-acp" / "codex-acp" entries alone.
3. Run `node usage.mjs` and report the percentages it prints.
4. Tell me to pick "Claude + usage" in Zed's agent panel picker.

If step 1 reports the adapter as not installed, tell me to open a `claude-acp`
thread in Zed once first so Zed downloads it, then re-run.
````

## Layout

```
proxy.mjs                 generic ACP relay + title injection
setup.mjs                 CLI: print or write this machine's Zed settings entry
usage.mjs                 CLI: print a provider's snapshot
bin/zed-agent-usage       what Zed spawns; finds node at run time (macOS, Linux)
bin/zed-agent-usage.cmd   the same, for Windows
providers/claude.mjs      Claude Code: Agent SDK get_usage control request
providers/codex.mjs       Codex: codex app-server account/rateLimits/read
providers/index.mjs       filename-based provider discovery
lib/windows.mjs           window labelling and suffix formatting
lib/resolve.mjs           locating node and the binaries Zed already installed
lib/jsonc.mjs             comment-preserving settings.json edits
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
`initialize`, then `account/rateLimits/read`. The binary is whichever one Zed
installed, found by matching `@openai/codex-*/vendor/*/bin` rather than naming a
target triple, so a new platform or architecture needs no code change. Codex
reports windows by duration (`windowDurationMins`) rather than by name, and which
windows exist depends on the plan: a Plus account may report only the weekly
window with `secondary: null`, so you may see just `wk 0%`. Labels are derived
from the duration, so a plan that reports a 5-hour window gets `5h` with no code
change.

Fetched at startup, on every `usage_update` from the adapter (turn end,
rate-limited to one fetch per 15s), every 60s, and once just after a window's
reset falls due. Between fetches the title is re-rendered from the cached
snapshot every 30s so the countdown stays current without spawning anything.

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
- Labels count down to the window reset rather than naming its length, so a
  5-hour window resetting in 29 minutes reads `29m 26%`, and in 1h20m reads `1h 26%`
  (floored, so it never promises a reset early). The weekly window reads `wk` until
  its final 24 hours, then counts down too. Windows with no known reset time fall
  back to their static label.
- Re-decoration strips a previously appended suffix, so titles never stack.
- For Claude, weekly prefers the all-models window, falling back to the highest
  per-model window so the figure shown is always the binding one.
- When plan limits don't apply (API key, Bedrock, Vertex), nothing is appended.
- Zed has no icon option for custom agent servers, so a proxied thread shows a
  generic icon rather than the Claude or OpenAI one.

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `ZED_AGENT_USAGE_PROVIDER` | `claude` | Provider id, if `--provider` is not passed |
| `ZED_AGENT_USAGE_PROVIDER_PATH` | – | Absolute path to an out-of-tree provider |
| `ZED_AGENT_USAGE_REFRESH_MS` | `60000` | Background refresh interval |
| `ZED_AGENT_USAGE_RENDER_MS` | `30000` | How often the countdown label is re-rendered |
| `ZED_AGENT_USAGE_MIN_INTERVAL_MS` | `15000` | Minimum gap between fetches |
| `ZED_AGENT_USAGE_DEBUG` | – | `1` logs to stderr (Zed: `dev: open acp logs`) |
| `ZED_AGENT_USAGE_NODE` | auto | Node binary the launcher runs the proxy with |
| `ZED_AGENT_USAGE_ADAPTER_COMMAND` / `_ARGS` | auto | Override the wrapped adapter |
| `CLAUDE_AGENT_SDK` | auto | Override the Claude SDK `sdk.mjs` path |
| `CODEX_BIN` | auto | Override the `codex` binary path |

## Tests

```sh
npm test                      # settings edits, then the proxy against a canned
                              # adapter and stub provider, both directly and
                              # through the launcher; asserts the exact title
npm run test:launcher         # just the launcher pass
npm run setup                 # print the entry for this machine
npm run usage                 # print the Claude snapshot
npm run usage:codex           # print the Codex snapshot
npm run test:real             # proxy against the real claude-acp (handshake only)
npm run test:real:codex       # proxy against the real codex-acp (handshake only)
node test/real.mjs --launcher # ...started exactly as Zed is configured to
PROMPT=hi npm run test:real   # also runs one short turn (uses quota)
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
