# zed-agent-usage-title-tracker

Shows your Claude or Codex plan usage in Zed's agent panel, counting down to each
window's reset.

It adds one read-only item to the selector row at the bottom of a thread:

```
Bypass Permissions   Opus (1M context)   Xhigh   Fast mode   4h 11% · wk 15%
```

`4h 11%` means the 5-hour window is 11% used and resets in 4 hours. Hover for the
exact reset times.

## Setup

Nothing to install — no dependencies, and it reuses the adapters and node that
Zed already downloaded.

```sh
node setup.mjs            # show what it will write, and where
node setup.mjs --write    # write it, backing up settings.json first
```

Then pick **Claude + usage** in Zed's agent panel picker. For Codex too:
`node setup.mjs --provider codex --write`.

Your existing `claude-acp` / `codex-acp` entries keep working, so you can switch
back any time.

**Or hand this link to your coding agent and let it do the setup:**

```
https://raw.githubusercontent.com/ortwinvanderstappen/zed-agent-usage-title-tracker/main/agent-instructions.md
```

## How it works

Zed extensions have no UI at all, so this is a stdio proxy in the ACP connection:

```
Zed  <--stdio-->  proxy.mjs  <--stdio-->  <agent>-acp adapter
```

Zed renders one selector per entry in the session's config-option set, and
nothing says that set may only hold the adapter's own. So the proxy appends one
of its own (`_usage`; ACP reserves the `_` prefix for custom use) and passes
everything else through untouched. Clicking it would make Zed ask the adapter to
set an option it has never heard of, so the proxy answers that request itself.

Usage is fetched at startup, at each turn end, every 60s, and just after a window
resets. In between, the label is re-rendered from cache every 30s so the
countdown stays current.

Zed runs one proxy per window, so a snapshot is shared between them through a
file in the temp dir — N proxies cost one fetch, not N. If reads start failing,
the label gains a `?` and the tooltip says how old the numbers are, rather than
showing figures that have quietly stopped moving.

## Where the numbers come from

No credentials are handled and no model calls are made, so no quota is used —
both providers delegate to a subprocess that authenticates itself.

- **Claude** — the Agent SDK's `get_usage` control request, the data behind
  `/usage`. It is marked experimental upstream; if renamed,
  `providers/claude.mjs` is the only place to change.
- **Codex** — `codex app-server` → `account/rateLimits/read`.

Adding another agent is one file: see [providers/README.md](providers/README.md).

## Warning marker

Above 90% on any window, the label gains a red marker:

```
22m 94% · wk 88%      ->      🔴 22m 94% · wk 88%
```

Below that there is no marker — in a row of plain text, it appearing is the
signal. An emoji is used because ACP has no colour or severity field; the label
is a plain string Zed paints with your theme.

The threshold is yours to set — any percentage from 0 to 100. Add an `env` block
to the agent entry in `settings.json`:

```json
"env": {
  "ZED_AGENT_USAGE_MARKER_AT": "75",
  "ZED_AGENT_USAGE_MARKER": "🔴"
}
```

| Want | Set |
| --- | --- |
| Warn earlier | `ZED_AGENT_USAGE_MARKER_AT=75` |
| See it right now | `ZED_AGENT_USAGE_MARKER_AT=0` |
| Never | `ZED_AGENT_USAGE_MARKER=off` (or `MARKER_AT=100`) |
| A different glyph | `ZED_AGENT_USAGE_MARKER=⚠️` |

Out-of-range values are clamped and unparseable ones fall back to 90, so a typo
cannot quietly switch the warning off. `ZED_AGENT_USAGE_DEBUG=1` logs the
threshold actually in effect.

Settings are read at startup, so restart the agent after editing.

## Hiding selectors

That row gets busy. Any of the agent's own selectors can be dropped from it,
which is useful for ones you have pinned in `settings.json` and never touch:

```json
"env": { "ZED_AGENT_USAGE_HIDE": "mode,fast" }
```

Zed then renders only what is left, plus the usage. To find the ids, start with
`ZED_AGENT_USAGE_DEBUG=1` and look for the `config options:` line in
`dev: open acp logs` — Claude offers `mode`, `model`, `effort`, `fast`; Codex
`mode`, `collaboration_mode`, `model`, `reasoning_effort`, `fast-mode`.

A hidden selector can no longer be changed from the panel, so pin the value you
want in `default_config_options` first.

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `ZED_AGENT_USAGE_MARKER` | `🔴` | Warning glyph; `off` disables |
| `ZED_AGENT_USAGE_MARKER_AT` | `90` | Percentage (0-100) above which it appears |
| `ZED_AGENT_USAGE_REFRESH_MS` | `60000` | Fetch interval |
| `ZED_AGENT_USAGE_RENDER_MS` | `30000` | Re-render interval for the countdown |
| `ZED_AGENT_USAGE_MIN_INTERVAL_MS` | `15000` | Minimum gap between fetches |
| `ZED_AGENT_USAGE_CACHE` | on | `off` stops sharing snapshots between proxies |
| `ZED_AGENT_USAGE_CACHE_MS` | `60000` | How long a shared snapshot may be reused |
| `ZED_AGENT_USAGE_STALE_MS` | `300000` | Age after which the label shows `?` |
| `ZED_AGENT_USAGE_HIDE` | – | Config-option ids to hide from the row |
| `ZED_AGENT_USAGE_DEBUG` | – | `1` logs to stderr (`dev: open acp logs`) |
| `ZED_AGENT_USAGE_PROVIDER` | `claude` | Provider, if `--provider` is not passed |
| `ZED_AGENT_USAGE_PROVIDER_PATH` | – | An out-of-tree provider module |
| `ZED_AGENT_USAGE_NODE` | auto | Node the launcher uses |
| `ZED_AGENT_USAGE_ADAPTER_COMMAND` / `_ARGS` | auto | Override the wrapped adapter |
| `CLAUDE_AGENT_SDK` / `CODEX_BIN` | auto | Override a provider's binary |

## Layout

```
proxy.mjs                 ACP relay + the injected selector
setup.mjs                 writes this machine's Zed settings entry
usage.mjs                 prints a provider's snapshot
bin/zed-agent-usage[.cmd] what Zed spawns; finds node at run time
providers/                one file per agent
lib/windows.mjs           countdown labelling
lib/cache.mjs             snapshot shared between proxies
lib/resolve.mjs           finding node and Zed's installed binaries
lib/jsonc.mjs             comment-preserving settings.json edits
```

## Tests

```sh
npm test                  # unit, settings, and the proxy against a canned adapter
npm run usage             # live Claude snapshot (or: npm run usage:codex)
npm run test:real         # against the real adapter, handshake only
```

## Limitations

- Zed has no icon option for custom agents, so proxied entries show a generic
  icon rather than the Claude or OpenAI one.
- The proxy is long-lived: after updating this repo, restart the agent before
  changes appear.

## Notes

Two things that look like they should work, but don't:

- Zed already receives `_meta["_claude/rateLimit"]` from the Claude adapter, but
  ignores it — and it carries no percentage until you are past a warning
  threshold anyway.
- `~/.claude/projects/*.jsonl` has token counts, not plan-limit percentages.

Zed discussion [#54792](https://github.com/zed-industries/zed/discussions/54792)
asks for this natively.

## License

[MIT](LICENSE) — free to use, modify and redistribute.

Not affiliated with Anthropic, OpenAI or Zed Industries. Relies on interfaces
that are internal or marked experimental, so it may break on any upstream
release.
