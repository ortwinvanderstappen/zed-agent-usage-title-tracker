/** Claude Code provider.
 *
 *  Usage comes from the Agent SDK's `get_usage` control request -- the same data
 *  `/usage` prints. The SDK subprocess authenticates itself, so no credentials
 *  are handled here, and no model call is made, so no quota is consumed.
 */

import { firstExisting, resolveNodeAdapter, zedPaths } from "../lib/resolve.mjs";

const ADAPTER_REL =
  "external_agents/registry/npx/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
const SDK_REL =
  "external_agents/registry/npx/claude-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

async function loadSdk() {
  const entry = firstExisting([process.env.CLAUDE_AGENT_SDK, ...zedPaths(SDK_REL)]);
  if (!entry) {
    throw new Error(
      `@anthropic-ai/claude-agent-sdk not found. Set CLAUDE_AGENT_SDK to its sdk.mjs path.`,
    );
  }
  return import(`file://${entry}`);
}

/** A prompt stream that stays open without ever sending a message: control
 *  requests need streaming input mode, and staying silent keeps the session idle
 *  so no turn is ever started. */
function idlePrompt() {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
}

export default {
  id: "claude",
  displayName: "Claude",
  // Short value labels ("Xhigh"), so the usage suffix fits without truncating.
  selectorId: "effort",

  resolveAdapter() {
    return resolveNodeAdapter({
      relative: ADAPTER_REL,
      npmPackage: "@agentclientprotocol/claude-agent-acp",
    });
  },

  async fetchUsage({ cwd = process.cwd(), timeoutMs = 20_000 } = {}) {
    const { query } = await loadSdk();
    const q = query({
      prompt: idlePrompt(),
      options: { cwd, settingSources: [], mcpServers: {}, includePartialMessages: false },
    });

    // The transport only connects once the caller starts consuming.
    const drain = (async () => {
      try {
        for await (const _ of q) {
          /* no messages expected */
        }
      } catch {
        /* teardown races are expected */
      }
    })();

    const timer = setTimeout(() => q.close?.(), timeoutMs);
    try {
      const res = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      const limits = res.rate_limits ?? {};

      // Weekly: prefer the all-models window, else the highest per-model window,
      // so the figure shown is always the binding one.
      const perModel = [limits.seven_day_opus, limits.seven_day_sonnet, limits.seven_day_oauth_apps]
        .filter((w) => w && typeof w.utilization === "number")
        .sort((a, b) => b.utilization - a.utilization);
      const weekly =
        limits.seven_day?.utilization != null ? limits.seven_day : perModel[0];

      const windows = [];
      if (typeof limits.five_hour?.utilization === "number") {
        windows.push({
          label: "5h",
          usedPercent: limits.five_hour.utilization,
          resetsAt: limits.five_hour.resets_at ?? null,
        });
      }
      if (typeof weekly?.utilization === "number") {
        windows.push({ label: "wk", usedPercent: weekly.utilization, resetsAt: weekly.resets_at ?? null });
      }

      return {
        available: res.rate_limits_available === true,
        planType: res.subscription_type ?? null,
        windows,
      };
    } finally {
      clearTimeout(timer);
      q.close?.();
      try {
        await q.return?.(undefined);
      } catch {
        /* ignore */
      }
      void drain;
    }
  },
};
