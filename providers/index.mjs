/** Provider discovery.
 *
 *  A provider is a module in this directory whose default export is:
 *
 *    {
 *      id: "myagent",                      // must match the filename
 *      displayName: "My Agent",
 *      resolveAdapter(): {command, args},  // the ACP adapter to wrap
 *      fetchUsage(): Promise<{             // no quota should be consumed here
 *        available: boolean,
 *        planType: string | null,
 *        windows: [{ label, usedPercent, resetsAt }],
 *      }>,
 *    }
 *
 *  Drop in `providers/<id>.mjs` and it is selectable as `--provider <id>` --
 *  no registration needed. See providers/README.md.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function listProviders() {
  return readdirSync(here)
    .filter((f) => f.endsWith(".mjs") && f !== "index.mjs")
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
}

function validate(provider, source) {
  for (const key of ["id", "resolveAdapter", "fetchUsage"]) {
    if (!provider?.[key]) throw new Error(`Provider ${source} is missing "${key}"`);
  }
  return provider;
}

/** Load a provider by id, or from ZED_AGENT_USAGE_PROVIDER_PATH for out-of-tree
 *  providers (an absolute path to a module with the same default export). */
export async function loadProvider(id) {
  const override = process.env.ZED_AGENT_USAGE_PROVIDER_PATH;
  if (override) {
    const mod = await import(`file://${path.resolve(override)}`);
    return validate(mod.default, override);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(id ?? "")) {
    throw new Error(`Invalid provider id ${JSON.stringify(id)}`);
  }
  const available = listProviders();
  if (!available.includes(id)) {
    throw new Error(`Unknown provider "${id}". Available: ${available.join(", ")}`);
  }
  const mod = await import(`file://${path.join(here, `${id}.mjs`)}`);
  return validate(mod.default, id);
}
