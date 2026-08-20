/** Stands in for claude-agent-acp: replays a canned ACP message sequence so the
 *  proxy's title rewriting can be tested without an API call. */
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      continue;
    }

    if (msg.method === "session/new") {
      const sessionId = "sess_test_1";
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });

      // A normal turn: some output, a usage_update, then the title at turn end.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "working" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "usage_update", used: 12345, size: 200000 },
        },
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "session_info_update", title: "Fix auth bug" },
          },
        });
      }, 200);
    }
  }
});
