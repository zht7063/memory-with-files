import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const src = path.resolve(import.meta.dirname, "../src");
function dependencies(file: string) {
  const tree = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
  );
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(tree) === "require") &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

test("core and contracts cannot depend on integrations, lifecycle, or host SDKs", () => {
  const seen = new Set<string>();
  function check(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of dependencies(file)) {
      assert.ok(
        !/^(@modelcontextprotocol\/|@mariozechner\/|@openai\/codex)/.test(
          specifier,
        ),
        `${file}: host SDK ${specifier}`,
      );
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(
        path.dirname(file),
        specifier.replace(/\.js$/, ".ts"),
      );
      assert.ok(
        !/\/(integrations|lifecycle)\//.test(target),
        `${file} imports ${specifier}`,
      );
      if (file.startsWith(path.join(src, "contracts") + path.sep))
        assert.ok(
          !target.startsWith(path.join(src, "storage") + path.sep),
          `${file}: contracts must not read storage`,
        );
      check(target);
    }
  }
  for (const dir of ["core", "contracts"]) {
    for (const file of fs.readdirSync(path.join(src, dir), {
      recursive: true,
    })) {
      if (String(file).endsWith(".ts"))
        check(path.join(src, dir, String(file)));
    }
  }
});
