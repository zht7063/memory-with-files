// Layering is enforced by tests: each layer may import only the layer directly beneath it.
//   core  -> node:* and @iarna/toml only
//   cli   -> ../core/index.ts (the public core API, never core internals)
//   mcp   -> ../cli/index.ts and the MCP SDK (@modelcontextprotocol/server); only server.ts touches the SDK
//   hooks -> ../mcp/index.ts
//   bin   -> ../cli/main.ts, ../cli/stdin.ts, ../mcp/server.ts (dispatch only; mcp is lazy-loaded)
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;

function importsOf(text: string): string[] {
  return [
    ...[...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/g)].map(
      (m) => m[1]!,
    ),
    ...[...text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!),
    ...[...text.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)].map((m) => m[1]!),
  ];
}

function check(layer: string, allowed: (spec: string) => boolean): void {
  const dir = join(SRC, layer);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    for (const spec of importsOf(readFileSync(join(dir, file), 'utf8'))) {
      assert.ok(allowed(spec), `src/${layer}/${file} must not import '${spec}'`);
    }
  }
}

const sibling = (spec: string): boolean => /^\.\/[\w-]+\.ts$/.test(spec);

describe('layering', () => {
  it('cli imports only node:*, its own files and the public core API', () => {
    check('cli', (s) => s.startsWith('node:') || sibling(s) || s === '../core/index.ts');
  });

  it('mcp imports only node:*, its own files, the cli API and the MCP SDK (server.ts only)', () => {
    check(
      'mcp',
      (s) =>
        s.startsWith('node:') ||
        sibling(s) ||
        s === '../cli/index.ts' ||
        /^@modelcontextprotocol\/server(\/stdio)?$/.test(s),
    );
    for (const file of readdirSync(join(SRC, 'mcp')).filter((f) => f.endsWith('.ts'))) {
      if (file === 'server.ts') continue;
      for (const spec of importsOf(readFileSync(join(SRC, 'mcp', file), 'utf8'))) {
        assert.ok(!spec.startsWith('@'), `src/mcp/${file} must not load the SDK: '${spec}'`);
      }
    }
  });

  it('what hooks load from mcp (index.ts) is the tool layer, not the server or the SDK', () => {
    assert.deepEqual(importsOf(readFileSync(join(SRC, 'mcp', 'index.ts'), 'utf8')), [
      './tools.ts',
      './tools.ts',
    ]);
  });

  it('hooks import only node:*, their own files and the mcp API', () => {
    check('hooks', (s) => s.startsWith('node:') || sibling(s) || s === '../mcp/index.ts');
  });

  it('the bin is a dispatcher: it imports only the cli command line, its stdin reader and the mcp server', () => {
    check(
      'bin',
      (s) =>
        s.startsWith('node:') ||
        s === '../cli/main.ts' ||
        s === '../cli/stdin.ts' ||
        s === '../mcp/server.ts',
    );
  });

  it('no layer below mcp can reach the SDK, and the SDK is a runtime dependency', () => {
    for (const layer of ['core', 'cli']) {
      const dir = join(SRC, layer);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        for (const spec of importsOf(readFileSync(join(dir, file), 'utf8'))) {
          assert.ok(!spec.startsWith('@modelcontextprotocol'), `src/${layer}/${file}: '${spec}'`);
        }
      }
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.match(pkg.dependencies['@modelcontextprotocol/server']!, /^\d+\.\d+\.\d+$/, 'exact pin');
  });

  it('the checker really sees imports (self-test)', () => {
    const seen = importsOf(
      "import a from 'node:fs';\nexport { b } from '../core/index.ts';\nconst c = await import('./x.ts');",
    );
    assert.deepEqual(seen.sort(), ['../core/index.ts', './x.ts', 'node:fs']);
  });

  it('the bin declared in package.json points at a source file and exports ./cli and ./mcp', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>;
      exports: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(pkg.bin), ['mwf']);
    const source = pkg.bin['mwf']!.replace('./dist/', 'src/').replace(/\.js$/, '.ts');
    assert.ok(existsSync(join(SRC, '..', source)), `${source} exists`);
    assert.ok('./cli' in pkg.exports && './core' in pkg.exports && './mcp' in pkg.exports);
  });
});
