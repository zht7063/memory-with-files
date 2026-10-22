// Architecture analyzer shared by tests/architecture.test.ts.
// Builds the full file-level import graph of a source tree (value, type-only,
// re-export, dynamic import(), require(), and `import("x")` type queries) and
// reports violations of the layering rules in docs/plan §6. Zero dependencies
// beyond the TypeScript compiler already used for the build.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type Edge = {
  from: string;
  to: string;
  line: number;
  typeOnly: boolean;
  exportStar: boolean;
};
export type Violation = { rule: string; key: string; detail: string };

export const LAYERS = [
  "L0 contracts",
  "L1 storage",
  "L2 retrieval/context",
  "L3 core",
  "L4 integrations",
  "L5 lifecycle",
  "L6 entry",
] as const;

/** Entry files (L6). Only these may import each other or the root barrel. */
export const ENTRY = [
  "cli.ts",
  "mcp.ts",
  "core.ts",
  "storage.ts",
  "setup.ts",
  "pi-adapter.ts",
  "protocol.ts",
];
/** Only these entry files may import the root barrel src/core.ts. */
export const ROOT_BARREL_IMPORTERS = ["cli.ts", "mcp.ts"];
/** Files allowed to mention host paths or branch on "pi"/"codex" (rule 7). */
export function hostKnowledgeAllowed(file: string) {
  return (
    file === "contracts/managed-surface.ts" ||
    file === "contracts/harness.ts" ||
    /^integrations\/(?!shared\/)[^/]+\//.test(file)
  );
}

/** Layer table: path → { layer, module }. Unregistered files return undefined. */
export function classify(
  file: string,
): { layer: number; module: string } | undefined {
  if (ENTRY.includes(file)) return { layer: 6, module: "entry" };
  const [top, second] = file.split("/");
  if (!file.includes("/")) return undefined;
  switch (top) {
    case "contracts":
      return { layer: 0, module: "contracts" };
    case "storage":
      return { layer: 1, module: "storage" };
    case "retrieval":
      return { layer: 2, module: "retrieval" };
    case "context":
      return { layer: 2, module: "context" };
    case "core":
      return { layer: 3, module: "core" };
    case "integrations":
      if (file === "integrations/registry.ts")
        return { layer: 4, module: "integrations/registry" };
      return file.split("/").length > 2
        ? { layer: 4, module: `integrations/${second}` }
        : undefined;
    case "lifecycle":
      return { layer: 5, module: "lifecycle" };
  }
  return undefined;
}

function listFiles(root: string) {
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => f.split(path.sep).join("/"))
    .sort();
}

type Parsed = {
  specifiers: {
    text: string;
    line: number;
    typeOnly: boolean;
    exportStar: boolean;
  }[];
  pureReexport: boolean;
  hostHits: string[];
};

const HOST_PATH = /(^|[/\\])\.(pi|codex)([/\\]|$)/;
const HOST_ID = new Set(["pi", "codex"]);
const COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function parse(file: string, text: string): Parsed {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers: Parsed["specifiers"] = [];
  const hostHits: string[] = [];
  const line = (n: ts.Node) =>
    tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1;
  const isHostId = (n: ts.Node) =>
    (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
    HOST_ID.has(n.text);
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? Boolean(node.importClause?.isTypeOnly)
        : node.isTypeOnly;
      specifiers.push({
        text: node.moduleSpecifier.text,
        line: line(node),
        typeOnly,
        exportStar: ts.isExportDeclaration(node) && !node.exportClause,
      });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({
        text: node.arguments[0].text,
        line: line(node),
        typeOnly: false,
        exportStar: false,
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push({
        text: node.argument.literal.text,
        line: line(node),
        typeOnly: true,
        exportStar: false,
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push({
        text: node.moduleReference.expression.text,
        line: line(node),
        typeOnly: node.isTypeOnly,
        exportStar: false,
      });
    }
    // Rule 7: host paths in any string/template text, host-id comparisons.
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      HOST_PATH.test(node.text) &&
      !(node.parent && ts.isImportDeclaration(node.parent)) &&
      !(node.parent && ts.isExportDeclaration(node.parent))
    )
      hostHits.push(`path ${JSON.stringify(node.text)}`);
    if (
      ts.isBinaryExpression(node) &&
      COMPARISON.has(node.operatorToken.kind) &&
      (isHostId(node.left) || isHostId(node.right))
    )
      hostHits.push(`compare ${node.getText(tree).replace(/\s+/g, " ")}`);
    if (ts.isCaseClause(node) && isHostId(node.expression))
      hostHits.push(`case ${node.expression.getText(tree)}`);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const pureReexport =
    tree.statements.length > 0 &&
    tree.statements.every(
      (s) =>
        ts.isExportDeclaration(s) &&
        s.moduleSpecifier !== undefined &&
        ts.isStringLiteral(s.moduleSpecifier),
    );
  return { specifiers, pureReexport, hostHits };
}

function resolve(root: string, from: string, spec: string, files: Set<string>) {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), spec),
  );
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    `${base}/index.ts`,
  ])
    if (files.has(candidate)) return candidate;
  const rel = path.posix.relative(".", base);
  return rel.startsWith("..") ? undefined : `${rel} (missing in ${root})`;
}

export function analyze(root: string) {
  const files = listFiles(root);
  const fileSet = new Set(files);
  const edges: Edge[] = [];
  const external: { from: string; pkg: string; line: number }[] = [];
  const pureReexport = new Set<string>();
  const hostHits = new Map<string, string[]>();
  for (const file of files) {
    const parsed = parse(file, fs.readFileSync(path.join(root, file), "utf8"));
    if (parsed.pureReexport) pureReexport.add(file);
    if (parsed.hostHits.length) hostHits.set(file, parsed.hostHits);
    for (const s of parsed.specifiers) {
      if (s.text.startsWith("node:")) continue;
      if (!s.text.startsWith(".")) {
        external.push({ from: file, pkg: s.text, line: s.line });
        continue;
      }
      const to = resolve(root, file, s.text, fileSet);
      if (to === undefined) continue; // escapes src (none today)
      edges.push({
        from: file,
        to,
        line: s.line,
        typeOnly: s.typeOnly,
        exportStar: s.exportStar,
      });
    }
  }

  const violations: Violation[] = [];
  const add = (rule: string, key: string, detail: string) =>
    violations.push({ rule, key: `${rule} ${key}`, detail });

  // Rule 1: every file is registered in the layer table.
  for (const file of files)
    if (!classify(file))
      add("unregistered", file, `${file} has no layer in tests/arch.ts`);

  for (const e of edges) {
    const a = classify(e.from);
    const b = classify(e.to);
    const where = `${e.from}:${e.line}${e.typeOnly ? " (type-only)" : ""}`;
    if (!a || !b) continue;
    const key = `${e.from} -> ${e.to}`;
    // Rule 2: no upward / cross-layer / same-layer cross-module imports.
    if (b.layer === 6 && a.layer !== 6)
      add("entry-import", key, `${where}: only entry files may import ${e.to}`);
    else if (b.layer > a.layer)
      add(
        "upward",
        key,
        `${where}: ${LAYERS[a.layer]} must not import ${LAYERS[b.layer]} (${e.to})`,
      );
    else if (b.layer === a.layer && a.module !== b.module) {
      const toShared =
        a.module.startsWith("integrations/") &&
        b.module === "integrations/shared";
      const registryToAdapter =
        a.module === "integrations/registry" &&
        /^integrations\/[^/]+\/adapter\.ts$/.test(e.to);
      if (a.layer !== 6 && !toShared && !registryToAdapter)
        add(
          a.layer === 4 ? "adapter-isolation" : "same-layer",
          key,
          `${where}: ${a.module} must not import sibling ${b.module}`,
        );
    }
    // Rule 5: adapters are reachable only via the registry; integrations ↛ lifecycle
    // is covered by "upward".
    if (
      /^integrations\/[^/]+\/adapter\.ts$/.test(e.to) &&
      e.from !== "integrations/registry.ts" &&
      classify(e.from)?.module !== classify(e.to)?.module
    )
      add(
        "adapter-isolation",
        key,
        `${where}: only the registry imports adapters`,
      );
    // Rule 4: root barrel and pure re-export shims are for entry files only.
    if (e.to === "core.ts" && !ROOT_BARREL_IMPORTERS.includes(e.from))
      add(
        "root-barrel",
        key,
        `${where}: only cli.ts/mcp.ts may import core.ts`,
      );
    else if (pureReexport.has(e.to) && a.layer !== 6)
      add("reexport-barrel", key, `${where}: imports re-export shim ${e.to}`);
    if (e.exportStar && a.layer !== 6 && a.layer !== b.layer)
      add(
        "export-star",
        key,
        `${where}: \`export *\` across layers (${LAYERS[a.layer]} → ${LAYERS[b.layer]})`,
      );
  }

  // Rule 3: no cycles (Tarjan SCC over every edge, type-only included).
  const adjacency = new Map<string, Set<string>>();
  for (const f of files) adjacency.set(f, new Set());
  for (const e of edges) adjacency.get(e.from)?.add(e.to);
  for (const scc of tarjan(adjacency))
    if (scc.length > 1 || adjacency.get(scc[0]!)?.has(scc[0]!))
      add(
        "cycle",
        [...scc].sort().join(" <-> "),
        `import cycle: ${[...scc].sort().join(" -> ")}`,
      );

  // Rule 6: external dependency ownership.
  const HOST_SDK = /^(@mariozechner\/|@earendil-works\/|@openai\/codex)/;
  for (const x of external) {
    const layer = classify(x.from)?.layer ?? -1;
    const where = `${x.from}:${x.line}`;
    const key = `${x.from} -> ${x.pkg.split("/").slice(0, 2).join("/")}`;
    if (x.pkg.startsWith("@modelcontextprotocol/") && x.from !== "mcp.ts")
      add("external", key, `${where}: MCP SDK only in mcp.ts`);
    if (
      x.pkg === "@iarna/toml" &&
      !x.from.startsWith("integrations/codex/") &&
      !x.from.startsWith("lifecycle/")
    )
      add(
        "external",
        key,
        `${where}: @iarna/toml only in integrations/codex or lifecycle`,
      );
    if (HOST_SDK.test(x.pkg) && layer >= 0 && layer <= 3)
      add("external", key, `${where}: host SDK ${x.pkg} in ${LAYERS[layer]}`);
  }

  // Rule 7: host knowledge.
  for (const [file, hits] of hostHits)
    if (!hostKnowledgeAllowed(file))
      for (const hit of hits)
        add(
          "host-literal",
          `${file} :: ${hit}`,
          `${file}: host literal/branch ${hit}`,
        );

  return { files, edges, violations };
}

function tarjan(graph: Map<string, Set<string>>) {
  let index = 0;
  const stack: string[] = [];
  const on = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];
  function strong(v: string) {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        scc.push(w);
      } while (w !== v);
      out.push(scc);
    }
  }
  for (const v of graph.keys()) if (!idx.has(v)) strong(v);
  return out;
}

/** Group violations by key → count, for ratchet comparison. */
export function tally(violations: Violation[]) {
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
  return counts;
}
