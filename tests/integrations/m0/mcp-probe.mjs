// M0 protocol probe only: no MWF production implementation or user data.
import fs from "node:fs";
import readline from "node:readline";
const [log, expectedRoot, delay = "0"] = process.argv.slice(2);
const cwd = fs.realpathSync(process.cwd());
const allowed = cwd === expectedRoot;
fs.appendFileSync(
  log,
  JSON.stringify({
    at: Date.now(),
    event: "mcp_start",
    cwd,
    expectedRoot,
    allowed,
    node: process.execPath,
  }) + "\n",
);
const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    await new Promise((resolve) => setTimeout(resolve, Number(delay)));
    fs.appendFileSync(
      log,
      JSON.stringify({ event: "mcp_ready", at: Date.now() }) + "\n",
    );
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "mwf-m0-probe", version: "0.0.0" },
    };
  } else if (request.method === "tools/list") {
    result = {
      tools: [
        {
          name: "status",
          description: "Inspect synthetic M0 root binding",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  } else if (request.method === "tools/call") {
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            allowed,
            cwd,
            code: allowed ? "OK" : "ROOT_MISMATCH",
          }),
        },
      ],
      isError: !allowed,
    };
  } else if (request.method === "ping") result = {};
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      }) + "\n",
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
});
input.on("close", () => process.exit(0));
