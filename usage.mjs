#!/usr/bin/env node
/** Print a provider's usage snapshot -- handy for checking setup.
 *
 *   node usage.mjs            # default provider: claude
 *   node usage.mjs codex
 */

import { formatWindows } from "./lib/windows.mjs";
import { listProviders, loadProvider } from "./providers/index.mjs";

const id = process.argv[2] ?? process.env.CLAUDE_USAGE_PROVIDER ?? "claude";

try {
  const provider = await loadProvider(id);
  const usage = await provider.fetchUsage();
  console.log(JSON.stringify({ provider: provider.id, ...usage }, null, 2));
  console.log(`\n${provider.displayName}:${formatWindows(usage.windows) || " no windows reported"}`);
} catch (err) {
  console.error(`${err?.message || err}`);
  console.error(`\nproviders: ${listProviders().join(", ")}`);
  process.exit(1);
}
