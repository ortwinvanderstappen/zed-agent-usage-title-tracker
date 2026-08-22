# Writing a provider

A provider teaches the proxy two things: **which ACP adapter to wrap**, and
**where that agent's usage numbers come from**. Drop a file in this directory and
it becomes selectable — there is no registry to edit.

```js
// providers/myagent.mjs
import { resolveNode } from "../lib/resolve.mjs";

export default {
  id: "myagent",            // must match the filename
  displayName: "My Agent",

  /** The ACP adapter to spawn and relay. */
  resolveAdapter() {
    return { command: resolveNode(), args: ["/path/to/myagent-acp"] };
  },

  /** Current plan usage. Must not consume quota. */
  async fetchUsage() {
    return {
      available: true,
      planType: "pro",
      windows: [
        { label: "5h", usedPercent: 16, resetsAt: "2026-08-20T22:59:59Z" },
        { label: "wk", usedPercent: 62, resetsAt: null },
      ],
    };
  },
};
```

Then:

```sh
node usage.mjs myagent          # check fetchUsage in isolation
node proxy.mjs --provider myagent
node test/real.mjs myagent      # handshake against the real adapter
```

## The contract

| Field | Notes |
| --- | --- |
| `id` | Must equal the filename minus `.mjs`; `[a-z0-9-]` only |
| `displayName` | Used in CLI output |
| `resolveAdapter()` | `{command, args}`, absolute `command`; `resolveNode()` gives you one |
| `fetchUsage()` | Resolves to `{available, planType, windows}` |
| `windows[]` | `{label, usedPercent, resetsAt}`; `label` is short (`5h`, `wk`) |

`windows` is an ordered list of any length, so an agent with one window, or
three, needs no special casing — order it shortest-first. Return
`available: false` (or an empty `windows`) when plan limits don't apply, e.g. on
API-key billing; the proxy then adds no selector at all.

`resetsAt` is carried through for future use and is not currently rendered.

## Guidance

- **Never consume quota.** Both shipped providers read account metadata only:
  Claude via the Agent SDK's `get_usage` control request, Codex via
  `codex app-server` → `account/rateLimits/read`. Neither makes a model call.
- **Don't handle credentials.** Both delegate to a subprocess that authenticates
  itself. If a provider seems to need a token from a keychain, look for a control
  request or local RPC that already does the auth for you.
- **Derive labels from data where possible.** `lib/windows.mjs` exports
  `labelForMinutes()`, which the Codex provider uses to turn `windowDurationMins`
  into `5h` / `wk`, so a new window length needs no code change.
- **Reuse the resolvers.** `lib/resolve.mjs` exports `zedPaths()`,
  `firstExisting()`, `resolveNode()` and `resolveNodeAdapter()` for locating
  binaries Zed already installed, which keeps versions matched to Zed's and
  avoids an npm install. It handles the per-platform support directories, so do
  not build paths from `homedir()` yourself -- on Windows Zed's lives under
  `%LOCALAPPDATA%`. Where a package or vendor directory name varies by platform,
  `zedGlob()` takes path segments containing `*` rather than one hardcoded
  target triple; `providers/codex.mjs` uses it to find the `codex` binary.
- **Throwing is fine.** `fetchUsage()` failures are logged and retried on the
  next refresh; the relay keeps working regardless.

## Out-of-tree providers

To keep a provider outside this repo, point at it directly:

```json
"env": { "ZED_AGENT_USAGE_PROVIDER_PATH": "/Users/me/my-provider.mjs" }
```

That takes precedence over `--provider`.
