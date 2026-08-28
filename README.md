# zed-agent-usage

Shows your Claude or Codex plan usage in Zed's agent panel, counting down to each
window's reset.

It adds one read-only item to the selector row at the bottom of a thread:

```
Bypass Permissions   Opus (1M context)   Xhigh   4h 11% · wk 15%   28 Aug, 11:39
```

`4h 11%` means the 5-hour window is 11% used and resets in 4 hours. Hover for
the exact reset times. The second item is when the thread was last worked in —
Zed's thread list only shows that relatively ("9m"), which is no help on
returning to a thread days later.

<img width="696" height="130" alt="image" src="https://github.com/user-attachments/assets/7e41e3f0-ad1e-4a21-bec2-0159c3485904" />
<img width="697" height="131" alt="image" src="https://github.com/user-attachments/assets/a3cb0758-029b-49d9-96e8-c6dfc5e3c648" />
<img width="200" height="215" alt="image" src="https://github.com/user-attachments/assets/bba88290-8201-4f0b-8754-4d336acb1440" />

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
https://raw.githubusercontent.com/ortwinvanderstappen/zed-agent-usage/main/agent-instructions.md
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

Usage only moves when a turn runs, so fetches are triggered by turns rather than
by the clock: session start, turn start, turn end, and just after a window
resets. `MIN_AGE` is the floor — however many chats fire triggers, a real fetch
happens at most that often. `MAX_AGE` is the ceiling while you are working.

Leave Zed idle for ten minutes and it stops refreshing altogether: turn start is
a trigger, so the figures are re-read the moment you type, and window resets
still fire. Archived and closed threads are forgotten rather than re-rendered
forever. The `?` marker means reads are *failing*, not that we chose to idle. In between, the label is re-rendered from
cache every 30s so the countdown stays current without fetching.

Reopening a thread goes through `session/load`, whose response omits the session
id, so the proxy correlates it back to the request that carried one — otherwise a
resumed thread would sit frozen at the figures it loaded with.

Zed runs one proxy per window, and they share one snapshot through a file in the
temp dir, so N windows cost one fetch rather than N. Freshness alone is not
enough for that: proxies started together would all miss the cache and all fetch
at once, so a lock elects one to do the work while the others wait for its
result. Ten chats cannot multiply the cost. If reads start failing,
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
| `ZED_AGENT_USAGE_MIN_AGE_MS` | `60000` | Floor: a real fetch happens at most this often, machine-wide |
| `ZED_AGENT_USAGE_MAX_AGE_MS` | `900000` | Ceiling: refresh anyway if nothing triggered for this long |
| `ZED_AGENT_USAGE_RENDER_MS` | `30000` | Re-render interval for the countdown |
| `ZED_AGENT_USAGE_CACHE` | on | `off` stops sharing snapshots between proxies |
| `ZED_AGENT_USAGE_STALE_AFTER` | `2` | Failed reads in a row before the label shows `?` |
| `ZED_AGENT_USAGE_IDLE_AFTER_MS` | `600000` | No turns for this long: stop refreshing |
| `ZED_AGENT_USAGE_HIDE` | – | Config-option ids to hide from the row |
| `ZED_AGENT_USAGE_LAST_ACTIVITY` | on | `off` removes the last-activity item |
| `ZED_AGENT_USAGE_CACHE_DIR` | temp dir | Where the shared snapshot and activity record live |
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
lib/cache.mjs             snapshot + activity record shared between proxies
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
