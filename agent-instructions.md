# Setup instructions for an agent

You are setting up **zed-agent-usage**, which shows Claude or Codex plan usage in
Zed's agent panel. Do the following for the user.

## 1. Get the repo

If it is not already checked out, clone it somewhere sensible and `cd` in:

```sh
git clone https://github.com/ortwinvanderstappen/zed-agent-usage.git
cd zed-agent-usage
```

There are no dependencies — do not run `npm install`.

## 2. Add the Zed agent entry

```sh
node setup.mjs            # shows what it will write, and where
node setup.mjs --write    # writes it, backing up settings.json first
```

`setup.mjs` resolves every path itself (settings location, Zed's node, the ACP
adapter), all of which differ per platform. **Do not hand-write paths** and do
not reformat `settings.json` — it is JSONC, and the writer preserves comments and
trailing commas.

For Codex as well:

```sh
node setup.mjs --provider codex --write
```

If it reports the adapter as not installed, tell the user to open a `claude-acp`
(or `codex-acp`) thread in Zed once so Zed downloads it, then re-run.

## 3. Check it works

```sh
node usage.mjs            # or: node usage.mjs codex
```

This prints the live percentages. It consumes no quota and touches no
credentials. If it errors, report the error rather than guessing.

## 4. Tell the user

- Pick **Claude + usage** (or **Codex + usage**) in Zed's agent panel picker.
- The usage appears as an extra item in the selector row at the bottom of a
  thread, e.g. `4h 11% · wk 15%`, counting down to each window's reset.
- Their existing `claude-acp` / `codex-acp` entries are untouched and still work.
- The proxy is long-lived, so after any update to this repo the agent needs
  restarting (kill the `proxy.mjs` process, or restart Zed) before changes show.
