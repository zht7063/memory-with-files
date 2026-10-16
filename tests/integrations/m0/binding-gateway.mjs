// M0 only: exercise the fixed upstream core without migrating it into this repo.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [baseline, boundRoot, generation] = process.argv.slice(2);
const { execute } = await import(pathToFileURL(path.join(baseline, 'dist/core.js')));
const { McpServer } = await import(pathToFileURL(path.join(baseline, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js')));
const { StdioServerTransport } = await import(pathToFileURL(path.join(baseline, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')));
const cwd = fs.realpathSync(process.cwd());
function guard() {
  let root = cwd;
  while (!fs.existsSync(path.join(root, '.mwf/config.json'))) {
    const parent = path.dirname(root);
    if (parent === root) throw Error('NO_PROJECT');
    root = parent;
  }
  if (root !== boundRoot) throw Error('ROOT_MISMATCH');
  const config = JSON.parse(fs.readFileSync(path.join(root, '.mwf/config.json'), 'utf8'));
  if (config.schema_version !== 1) throw Error('SCHEMA_MISMATCH');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.mwf/local/integration.json'), 'utf8'));
  if (receipt.receipt_version !== 2 || receipt.canonical_root !== root) throw Error('INVALID_RECEIPT');
  if (receipt.clients?.codex?.enabled !== true) throw Error('DISABLED');
  if (receipt.clients.codex.binding_generation !== generation) throw Error('BINDING_STALE');
}
let startupError;
try { guard(); } catch (error) { startupError = error.message; }
const server = new McpServer({ name: 'mwf-m0-binding', version: '0.0.0' });
for (const operation of ['bootstrap', 'add']) {
  server.registerTool(operation, { description: 'M0 fixed synthetic memory ' + operation }, async () => {
    try {
      if (startupError) throw Error(startupError);
      guard();
      // shortcut: not atomic with upstream write lock; production M3 must recheck inside its transaction.
      const result = execute(operation, { project_root: boundRoot, ...(operation === 'add' ? {
        type: 'knowledge', title: 'M0 write', summary: 'M0_WRITE_SENTINEL', body: 'M0_WRITE_SENTINEL',
      } : {}) });
      return { content: [{ type: 'text', text: JSON.stringify({ cwd, result }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ cwd, error: error.message }) }], isError: true };
    }
  });
}
await server.connect(new StdioServerTransport());
