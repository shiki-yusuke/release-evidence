// Architecture guard for spec.md "live 化の構造的防止": while cohort-2-live-lock.json declares
// state="locked", nothing under production src/** -- except src/shadow-cli/**, the one intended
// caller of the evaluator -- may import src/shadow/** (not even a type-only import, a multiline
// import, a dynamic import(), or an `export ... from`). This is what keeps the shadow evaluator
// from becoming a de facto gate by accident: a single import reaching a real deploy/gate code
// path would do exactly that, with no schema or runtime check able to catch it.
//
// terra review must-6 (2026-08-27): the previous version of this file only scanned src/cli/** and
// "deploy"-named files under src/core/**, using a single-line regex that a multiline import,
// dynamic import(), or export-from statement could all trivially evade. This version scans EVERY
// production src/** directory except src/shadow/** (itself) and src/shadow-cli/** (the allowed
// importer) -- default-deny, so a brand-new src/** directory added later is covered without this
// file changing -- and detects import-like specifiers via the real TypeScript parser (the same
// compiler `pnpm typecheck` already depends on) rather than a per-line regex, so statement shape
// (single-line, multiline, dynamic, export-from) cannot evade detection by formatting alone.
//
// terra re-review round C (2026-08-27), must-6 residual: a dynamic `import()` whose argument is
// NOT a plain string literal or no-substitution template (a string-concatenation
// BinaryExpression like `import("../" + "shadow/evaluate.js")`, a template WITH substitutions, a
// bare variable, a function call, ...) used to either be ignored entirely (BinaryExpression) or
// matched only by a best-effort substring test against the literal template chunks (which a
// specifier like `` `../${which}.js` `` naming no literal "shadow" text at all would evade). This
// version fails CLOSED instead: ANY dynamic import() argument this file cannot statically resolve
// to a literal string is treated as forbidden, unconditionally -- an import whose target cannot
// be proven safe is never assumed safe. The scan also now covers every production `.ts` file
// directly under `src/` (not only files inside a subdirectory), so a future `src/promote.ts`
// sibling to `src/core/`/`src/cli/` is covered without this file changing; `.d.ts` declaration
// files carry no runtime import to guard against and are excluded.
//
// terra round D re-audit (2026-08-27), must-6 residual: `import`/`import()`/`export ... from` are
// not the only module-loading mechanism reachable from a `.ts` file under Node -- CommonJS's
// synchronous `require()`, reachable from ESM via `node:module`'s `createRequire`, is a second,
// entirely separate loader this scan did not see at all (`import { createRequire } from
// "node:module"; const load = createRequire(import.meta.url); const shadow =
// load("../shadow/evaluate.js");` loaded the real module on Node 22 without tripping any check
// here, because the AST walk only ever looked at import/export declarations and `import()` call
// expressions, never at an ordinary function call). This version also treats a call to the global
// `require`, a local binding produced by `createRequire(...)`, or an immediately-invoked
// `createRequire(...)(...)` chain as equivalent to a dynamic `import()` call: its first argument
// is resolved and checked the same way (literal string -> checked against src/shadow/**;
// anything else -> fail-closed forbidden, unconditionally).
//
// terra round E (2026-08-27), must-2: round D's own `createRequire` detection matched only a
// local identifier whose TEXT is literally "createRequire" -- an import alias (`import {
// createRequire as cr } from "node:module"`, then `cr(import.meta.url)`) or a namespace import
// (`import * as m from "node:module"`, then `m.createRequire(import.meta.url)`) both reach the
// exact same loader while never binding a local identifier of that literal name, so neither was
// seen at all. This version first collects, from the file's own `node:module`/`module` imports,
// which local names are actually bound to the `createRequire` export (the import specifier's own
// `propertyName`, not just its local `name` -- this is what makes an alias transparent) and which
// local names are bound to the whole namespace, then treats an identifier in the first set OR a
// `<namespace>.createRequire` property access using a name from the second set as equivalent to
// the literal name "createRequire" everywhere round D already checked for it.
//
// terra round F (2026-08-27), supply-cut (policy change, not another binding shape): round E's
// evaluator found a THIRD identifier-tracking evasion on the very next pass -- a computed property
// access (`m["createRequire"]`), a destructuring-with-rename off a namespace object (`const {
// createRequire: cr } = ns`), and a plain alias copy (`const copied = imported`) all reach the
// same loader without ever producing a token shape rounds D and E were watching for. Each fix so
// far chased one more syntactic shape of the SAME leak -- direct name, then import alias and
// namespace property, and evidently there is no reason to believe a fourth, fifth, or Nth shape
// will not surface on the next review pass; identifier/binding tracking is fundamentally an
// enumeration of syntax forms, and TypeScript has more of those than this file can chase one round
// at a time. This version stops enumerating consumption shapes and instead cuts the supply: the
// ONLY way anything in a `.ts` file can reach `createRequire` (or Node's synchronous `require`) at
// all is to first `import`/`export ... from`/`require(...)`/`import(...)` the `node:module` (or
// CommonJS `module`) built-in itself -- there is no other path to that function in this language.
// So rather than tracking what a binding derived from `node:module` is later used for, this rule
// flags the supply step directly: ANY import-like reference to the literal module specifier
// "node:module" or "module" in production src/** (outside src/shadow-cli/**, the allowed importer)
// while the live lock is held, full stop -- a pure module-specifier string match, no identifier or
// binding tracking involved, so no future consumption shape (computed property, destructuring,
// alias, or one not yet invented) can evade it: none of them can exist without an import whose
// specifier text this check reads directly off the AST, before following where the value goes.
// Verified against the real repo (`listProductionSrcFiles`): production src/** has zero existing
// `node:module` usage, so this new rule breaks no legitimate code.
//
// The round D/E identifier-tracking machinery (`collectCreateRequireBindings`,
// `collectRequireBoundIdentifiers`, `isRequireLikeCall`, and the require-style hits inside
// `collectModuleSpecifiers`) is left in place below as defense in depth -- it still narrows a
// require-style load down to one that specifically targets `src/shadow/**`, which is useful if a
// future rule ever needs something less blunt than "no node:module at all". But it is explicitly
// NOT the primary guard the live lock relies on any more, and it must not be extended with more
// binding-shape special cases: identifier tracking is best-effort only, the guard of record for
// `node:module` is the supply-cut check below (`findNodeModuleSupplyUsages`).
//
// terra 6巡目 (2026-08-27), round F 再攻撃: round F の supply-cut は `node:module`/`module` という
// specifier の出現を塞いだが、同じローダーへ specifier を一度も書かずに到達する経路が3つ見つかった
// -- `process.getBuiltinModule("module").createRequire(...)` はどの Node プロセスにも既に存在する
// グローバルから同じ CommonJS ローダーへ到達し、import 文を一切経由しないため supply-cut は見えない;
// `eval('import("...")')` は ESM の dynamic import ローダーへ文字列経由で到達し、この AST 走査は
// 実際の import()/require 構文ノードしか見ないため eval に渡された文字列の中身は見えない; base64
// `data:` URL を渡した本物の import() 呼び出しは literal な文字列なので既存の「解決不能な specifier
// は forbidden」ルール（fail-closed）には引っかからない -- 解決できてしまう（specifier としては
// valid）だけで、この repo には使う正当な理由がないだけである。この版は3経路とも閉じる: 識別子
// "getBuiltinModule" の出現を無条件 forbidden（member access 含む、保守的な文字列一致）、`eval(...)`
// 呼び出しと `new Function(...)` を無条件 forbidden、literal な dynamic `import()` specifier は
// "./" / "../" / "node:" で始まるものだけを許可（data:/file:/http(s):/bare package literal は
// forbidden）とする。3つとも変更時点の production src に正当利用ゼロを確認済み。
//
// terra round G, オーケストレータ判断 (2026-08-27): この評価器が可決した3経路は、round D/E の
// createRequire 束縛形状の迂回、round F の node:module supply-cut 迂回に続く、同じ系列の次の1巡に
// すぎない。ここでラウンド H を重ねずに記録する判断: 静的な文字列/AST 走査はこの repo 内での
// 悪意ある変更のコストを上げることはできるが、それを不可能にすることはできない -- その変更を書ける
// 著者は、この検査ファイル自体や `cohort-2-live-lock.json` にも書き込み権限を持つため、迂回を追加
// する同じ変更でチェックを削除・弱体化できてしまう。よってこのガードの**脅威モデルは事故防止**
// （うっかり shadow を production 経路に配線する、コード補完が shadow のシンボルを引き込む、
// shadow のテストコードからのコピペ混入など）であり、**同一 repo 内の悪意ある著者は対象外**
// （静的走査とその対象が同じ信頼境界内にあるため、原理的にこの層の外側の問題である）。悪意への
// 防御はこの repo の外側の層 -- マージ前の外部レビュー・本ファイルと lock ファイルへの branch
// protection・実際に出荷するものへの digest 束縛 -- が担う。これはこの評価器自身の
// `privilege_boundary` predicate が自分自身について明記している境界と同型（spec.md / evaluate.ts
// 「a necessary condition, not a sufficient one」）: 静的走査は必要条件であって十分条件ではない。
// 以後、同じ「悪意ある著者」の脅威に対する新しい迂回形状を追いかけるラウンドは想定しない -- 次に
// ラウンドを起こす根拠になるのは、迂回（adversarial evasion）ではなく新しい「事故的な誤配線」の
// 形状がこれらの検査を素通りすると分かった場合のみである。

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const SHADOW_CORE_DIR = path.join(SRC_ROOT, "shadow");

function listTsFiles(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(abs));
    else if (entry.isFile() && abs.endsWith(".ts") && !abs.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

/** One import-like module specifier found in a source file. `resolvable=true` means the AST
 * proved it is a plain string literal (or no-substitution template) known in full at parse time.
 * `resolvable=false` covers EVERY other shape a dynamic `import(...)` argument can take --
 * a template WITH substitutions, string concatenation (`BinaryExpression`), a bare
 * variable/identifier, a function call, anything -- none of which this file can resolve to a
 * literal path statically. terra re-review round C (must-6 residual): such a specifier is
 * treated as forbidden UNCONDITIONALLY (fail-closed), never matched against a partial literal
 * substring -- an import target this file cannot prove safe is never assumed safe. */
interface SpecifierHit {
  specifier: string;
  resolvable: boolean;
  /** terra round G: true only for a dynamic `import(...)` call's own argument -- never for a
   * static `import`/`export ... from`, `import x = require(...)`, or a require-like call's
   * argument. Needed because the literal-prefix restriction below (G-1) is legitimate ONLY for
   * dynamic import(): a static `import ts from "typescript"` uses a bare package specifier
   * that would otherwise look identical to a forbidden literal. */
  isDynamicImport: boolean;
}

const MODULE_BUILTIN_SPECIFIERS = new Set(["node:module", "module"]);

/** From this file's own `import ... from "node:module"`/`"module"` statements: which local
 * identifier names are bound to the `createRequire` export itself (using each specifier's own
 * `propertyName` -- the pre-`as` name -- rather than its local `name`, so an alias like
 * `createRequire as cr` is resolved to "createRequire" regardless of what the local name is), and
 * which local identifier names are bound to the WHOLE namespace via `import * as m from
 * "node:module"` (terra round E must-2). Whole-file and shape-only, same fail-closed posture as
 * the rest of this scan -- over-collecting a name only ever adds more call sites to the
 * forbidden-argument check below. */
function collectCreateRequireBindings(sourceFile: ts.SourceFile): {
  localNames: ReadonlySet<string>;
  namespaceNames: ReadonlySet<string>;
} {
  const localNames = new Set<string>();
  const namespaceNames = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      MODULE_BUILTIN_SPECIFIERS.has(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings
    ) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (importedName === "createRequire") localNames.add(element.name.text);
        }
      } else if (ts.isNamespaceImport(bindings)) {
        namespaceNames.add(bindings.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { localNames, namespaceNames };
}

/** True for an expression that resolves to the `createRequire` function itself: a local
 * identifier bound to it directly (the default import name, or any `as`-alias -- see
 * `collectCreateRequireBindings`), or a `<namespace>.createRequire` property access where
 * `<namespace>` is a namespace import of `node:module`/`module` (terra round E must-2). */
function isCreateRequireExpression(
  expr: ts.Expression,
  createRequireNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expr)) return createRequireNames.has(expr.text);
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    namespaceNames.has(expr.expression.text) &&
    expr.name.text === "createRequire"
  );
}

/** Second pass over the file: every local identifier bound directly to a `createRequire(...)`
 * call result (`const load = createRequire(import.meta.url)`, `const req = cr(url)`, `const req2
 * = m.createRequire(url)`, ...) -- the callee is anything `isCreateRequireExpression` recognizes,
 * not just the literal name "createRequire". Deliberately whole-file and shape-only (no
 * scope/type resolution) -- fail-closed means over-collecting a name is harmless (it only ever
 * adds MORE call sites to the forbidden-argument check below), while under-collecting one would
 * silently let a require-style load through. */
function collectRequireBoundIdentifiers(
  sourceFile: ts.SourceFile,
  createRequireNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      isCreateRequireExpression(node.initializer.expression, createRequireNames, namespaceNames)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

/** True for a call expression that loads a module the CommonJS way: the bare global `require`,
 * a local binding produced by `createRequire(...)` (see `collectRequireBoundIdentifiers`), or an
 * immediately-invoked `createRequire(...)(...)` chain that was never bound to a name at all
 * (terra round D: `createRequire(import.meta.url)("../shadow/evaluate.js")` in one expression;
 * terra round E: the same chain via an alias or `<namespace>.createRequire`). */
function isRequireLikeCall(
  node: ts.CallExpression,
  requireBoundNames: ReadonlySet<string>,
  createRequireNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === "require" || requireBoundNames.has(callee.text);
  }
  return (
    ts.isCallExpression(callee) &&
    isCreateRequireExpression(callee.expression, createRequireNames, namespaceNames)
  );
}

/** Walks the real TypeScript AST (not a line-oriented regex) collecting every module specifier
 * reachable via: a static `import ... from "..."` (single-line or multiline -- the AST has no
 * concept of "line" at all, so formatting cannot hide one), an `export ... from "..."`, a dynamic
 * `import(...)` call (any argument shape -- see `SpecifierHit`'s doc comment), and a
 * require-like call (bare `require(...)`, a `createRequire(...)`-bound identifier called with
 * any argument, or a chained `createRequire(...)(...)` -- terra round D, same "any argument
 * shape" fail-closed treatment as dynamic `import()`). */
function collectModuleSpecifiers(fileName: string, text: string): SpecifierHit[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: SpecifierHit[] = [];
  const { localNames: createRequireNames, namespaceNames } =
    collectCreateRequireBindings(sourceFile);
  const requireBoundNames = collectRequireBoundIdentifiers(
    sourceFile,
    createRequireNames,
    namespaceNames,
  );

  function addFromExpression(expr: ts.Expression | undefined, isDynamicImport: boolean): void {
    if (!expr) return;
    if (ts.isStringLiteralLike(expr)) {
      hits.push({ specifier: expr.text, resolvable: true, isDynamicImport });
      return;
    }
    // Static `import`/`export ... from` declarations are grammatically always a string literal
    // (TS/JS syntax has no other form there), so this branch is only ever reached for a dynamic
    // `import(...)` (or `import x = require(...)`) argument, or a require-like call's argument,
    // that is NOT a plain string -- fail-closed, regardless of shape (BinaryExpression
    // concatenation, a template with substitutions, a bare identifier, ...).
    hits.push({ specifier: expr.getText(sourceFile), resolvable: false, isDynamicImport });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addFromExpression(node.moduleSpecifier as ts.Expression | undefined, false);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addFromExpression(node.arguments[0], true);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addFromExpression(node.moduleReference.expression, false);
    } else if (
      ts.isCallExpression(node) &&
      isRequireLikeCall(node, requireBoundNames, createRequireNames, namespaceNames)
    ) {
      addFromExpression(node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return hits;
}

function stripExt(p: string): string {
  return p.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
}

/** True when a statically-known relative specifier resolves into src/shadow/** itself (never
 * src/shadow-cli/**, a sibling directory that merely shares a name prefix), or when a
 * non-relative specifier (a bare package name or a `#subpath` import-map alias) names "shadow" as
 * one of its own path segments -- the latter is a defense-in-depth guard against a future alias
 * that could otherwise bypass a purely relative-path check. */
function specifierTargetsShadowCore(importerAbsFile: string, specifier: string): boolean {
  if (specifier.startsWith(".")) {
    const resolved = stripExt(path.resolve(path.dirname(importerAbsFile), specifier));
    const rel = path.relative(SHADOW_CORE_DIR, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }
  return specifier
    .replace(/^#/, "")
    .split("/")
    .some((segment) => segment.toLowerCase() === "shadow");
}

function isForbiddenSpecifier(importerAbsFile: string, hit: SpecifierHit): boolean {
  if (!hit.resolvable) return true; // fail-closed: an unresolvable import target is never safe
  return specifierTargetsShadowCore(importerAbsFile, hit.specifier);
}

function findShadowCoreImports(
  files: readonly string[],
): Array<{ file: string; specifier: string }> {
  const hits: Array<{ file: string; specifier: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const hit of collectModuleSpecifiers(file, text)) {
      if (isForbiddenSpecifier(file, hit)) {
        hits.push({ file: path.relative(REPO_ROOT, file), specifier: hit.specifier });
      }
    }
  }
  return hits;
}

/** terra round F supply-cut: true for a hit whose module specifier is the literal, resolved
 * string "node:module" or "module" -- deliberately ignorant of what the imported value is later
 * used for (no identifier/binding tracking). `collectModuleSpecifiers` already surfaces this
 * specifier text for every import-like site (static import, export-from, dynamic `import()`,
 * `import x = require(...)`, and a require-like call's own argument such as bare
 * `require("node:module")`) with no changes needed here -- this function only asks "is the target
 * itself the built-in module loader", not "what is the target used for afterward". */
function isNodeModuleSupplyHit(hit: SpecifierHit): boolean {
  return hit.resolvable && MODULE_BUILTIN_SPECIFIERS.has(hit.specifier);
}

/** Every import-like reference to `node:module`/`module` itself found in `files`, regardless of
 * what a later binding derived from it is used for. This is the round F primary defense: it
 * forbids the SUPPLY of the built-in module loader in guarded production code, not any particular
 * consumption shape of it, so a computed property access, a renamed destructure off a namespace
 * object, or a plain alias copy -- none of which touch a "createRequire"-shaped token at their own
 * call site -- are all still caught, because none of them can exist without an import statement
 * naming "node:module"/"module" that this function reads directly. */
function findNodeModuleSupplyUsages(
  files: readonly string[],
): Array<{ file: string; specifier: string }> {
  const hits: Array<{ file: string; specifier: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const hit of collectModuleSpecifiers(file, text)) {
      if (isNodeModuleSupplyHit(hit)) {
        hits.push({ file: path.relative(REPO_ROOT, file), specifier: hit.specifier });
      }
    }
  }
  return hits;
}

/** terra round G, G-1: identifiers this scan forbids outright, regardless of how they are
 * reached (member access, computed property, import, alias -- none of that matters, only the
 * literal text does). `getBuiltinModule` reaches `require`/`createRequire` via a global already
 * present on every Node `process` object (`process.getBuiltinModule("module").createRequire(...)`)
 * without ever importing `node:module`, so round F's supply-cut cannot see it; this check closes
 * that second supply path the same way round F closed the first -- by forbidding the identifier
 * itself, deliberately ignorant of what it is later used for. */
const FORBIDDEN_IDENTIFIER_SUBSTRINGS: readonly string[] = ["getBuiltinModule"];

/** Conservative textual scan (terra round G, G-1 -- deliberately NOT an AST identifier lookup):
 * a plain substring search over the raw file text for each name in
 * `FORBIDDEN_IDENTIFIER_SUBSTRINGS`. This catches every syntactic shape that would carry the
 * literal text "getBuiltinModule" -- `process.getBuiltinModule(...)`, a destructured/aliased
 * import of it, a computed `obj["getBuiltinModule"]` access -- without needing to enumerate
 * those shapes one at a time the way the round D/E createRequire-binding tracker had to. It will
 * not catch a specifier built from concatenated substrings (`"get" + "BuiltinModule"`); that is
 * an accepted gap of this cheap check, not a claim of exhaustiveness -- see this file's own
 * threat-model comment at the top. */
function findForbiddenIdentifierUsages(
  files: readonly string[],
): Array<{ file: string; identifier: string }> {
  const hits: Array<{ file: string; identifier: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const identifier of FORBIDDEN_IDENTIFIER_SUBSTRINGS) {
      if (text.includes(identifier)) {
        hits.push({ file: path.relative(REPO_ROOT, file), identifier });
      }
    }
  }
  return hits;
}

/** terra round G, G-1: every call to the global `eval(...)` or `new Function(...)` in a file,
 * found via the real AST (not a text search, since these are ordinary call/new expressions the
 * parser already distinguishes reliably from e.g. a local variable or property named `eval`).
 * `eval("import(...)")` reaches the ESM dynamic-import loader through a string this scan's
 * `collectModuleSpecifiers` never inspects (it only walks real import()/require syntax nodes);
 * forbidding `eval`/`Function` outright closes that path regardless of what string is ever
 * passed to them, without needing to parse string contents as code. */
function collectEvalAndFunctionConstructorHits(
  fileName: string,
  text: string,
): Array<"eval" | "Function"> {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: Array<"eval" | "Function"> = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "eval"
    ) {
      hits.push("eval");
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Function"
    ) {
      hits.push("Function");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return hits;
}

function findEvalAndFunctionConstructorUsages(
  files: readonly string[],
): Array<{ file: string; identifier: "eval" | "Function" }> {
  const hits: Array<{ file: string; identifier: "eval" | "Function" }> = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const identifier of collectEvalAndFunctionConstructorHits(file, text)) {
      hits.push({ file: path.relative(REPO_ROOT, file), identifier });
    }
  }
  return hits;
}

/** terra round G, G-1: the only dynamic `import()` specifier prefixes this repo's production
 * code has any legitimate reason to use -- a relative path, or a `node:`-prefixed builtin
 * (`node:module`/`module` itself is separately forbidden by `findNodeModuleSupplyUsages` above,
 * so allowing the `node:` prefix here does not reopen that hole). A literal `data:` URL passed
 * to a real `import()` call resolves fine (it IS a valid specifier) so the existing
 * fail-closed "unresolvable specifier" rule never sees it; restricting literal dynamic import()
 * targets to this prefix allowlist closes that gap directly. */
const ALLOWED_DYNAMIC_IMPORT_LITERAL_PREFIXES: readonly string[] = ["./", "../", "node:"];

/** Deliberately scoped to `hit.isDynamicImport` only: a static `import ts from "typescript"` (or
 * `export … from "pkg"`, or a require-like call) legitimately uses a bare package specifier that
 * would otherwise look identical to a forbidden literal -- this restriction would break real
 * code if applied there. Also skipped for `!hit.resolvable`: a non-literal dynamic import()
 * argument is already fail-closed forbidden by the existing shadow-core-import check above,
 * independent of this one. */
function isDisallowedDynamicImportLiteral(hit: SpecifierHit): boolean {
  if (!hit.isDynamicImport || !hit.resolvable) return false;
  return !ALLOWED_DYNAMIC_IMPORT_LITERAL_PREFIXES.some((prefix) =>
    hit.specifier.startsWith(prefix),
  );
}

function findDisallowedDynamicImportLiterals(
  files: readonly string[],
): Array<{ file: string; specifier: string }> {
  const hits: Array<{ file: string; specifier: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const hit of collectModuleSpecifiers(file, text)) {
      if (isDisallowedDynamicImportLiteral(hit)) {
        hits.push({ file: path.relative(REPO_ROOT, file), specifier: hit.specifier });
      }
    }
  }
  return hits;
}

/** Default-deny file list: every production `.ts` file under `src/` except `src/shadow/**` (the
 * guarded target itself) and `src/shadow-cli/**` (the one allowed importer, spec.md "配置") --
 * both entire subdirectories AND any `.ts` file sitting directly in `src/` itself (terra
 * re-review round C, must-6 residual: "走査対象は src/ 直下のディレクトリのみで、将来の
 * src/promote.ts は漏れます"). `.d.ts` declaration files are excluded (`listTsFiles`) since they
 * carry no runtime import to guard against. A brand-new `src/**` directory OR top-level file is
 * covered automatically -- no update to this file is needed when one is added, which is the whole
 * point of "default-deny" over an allowlist of known offenders. */
function listProductionSrcFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(SRC_ROOT, { withFileTypes: true })) {
    if (entry.name === "shadow" || entry.name === "shadow-cli") continue;
    const abs = path.join(SRC_ROOT, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(abs);
    }
  }
  return files;
}

function isLiveLockLocked(): boolean {
  const lock = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "cohort-2-live-lock.json"), "utf-8"),
  ) as { state: string };
  return lock.state === "locked";
}

describe('live-lock architecture guard (spec.md "live 化の構造的防止")', () => {
  it("cohort-2-live-lock.json is present and locked (this repo has not live-unlocked shadow)", () => {
    expect(isLiveLockLocked()).toBe(true);
  });

  it("no production src/** file outside src/shadow-cli/** imports src/shadow/** while the live lock is held (default-deny, terra review must-6)", () => {
    if (!isLiveLockLocked()) return; // the lock's own unlock PR is what's allowed to change this
    const files = listProductionSrcFiles();
    expect(files.length).toBeGreaterThan(0); // guard against a silent path-typo no-op
    expect(findShadowCoreImports(files)).toEqual([]);
  });

  it("the import-shadow detector itself actually fires on a real shadow import (self-test, not a false-green tripwire)", () => {
    const hits = findShadowCoreImports([path.join(REPO_ROOT, "test", "shadow-resolver.test.ts")]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("no production src/** file outside src/shadow-cli/** imports/requires node:module or module at all while the live lock is held (terra round F: supply-cut -- the loader itself is forbidden, independent of what any binding derived from it is later used for)", () => {
    if (!isLiveLockLocked()) return; // the lock's own unlock PR is what's allowed to change this
    const files = listProductionSrcFiles();
    expect(files.length).toBeGreaterThan(0); // guard against a silent path-typo no-op
    expect(findNodeModuleSupplyUsages(files)).toEqual([]);
  });

  it("no production src/** file outside src/shadow-cli/** references the identifier `getBuiltinModule` at all while the live lock is held (terra round G, G-1: process.getBuiltinModule(\"module\").createRequire(...) reaches the same CommonJS loader as node:module's createRequire without ever importing node:module, so round F's supply-cut cannot see it -- this is a second, independent supply path, closed the same way: forbid the identifier's mere presence)", () => {
    if (!isLiveLockLocked()) return; // the lock's own unlock PR is what's allowed to change this
    const files = listProductionSrcFiles();
    expect(files.length).toBeGreaterThan(0); // guard against a silent path-typo no-op
    expect(findForbiddenIdentifierUsages(files)).toEqual([]);
  });

  it("no production src/** file outside src/shadow-cli/** calls eval(...) or `new Function(...)` while the live lock is held (terra round G, G-1: eval('import(\"file:///.../shadow/evaluate.js\")') actually loads the module on Node -- this AST scan only ever looks at real import()/require syntax nodes, never at string contents handed to eval, so forbidding eval/Function itself closes the path regardless of what string is ever given to them)", () => {
    if (!isLiveLockLocked()) return; // the lock's own unlock PR is what's allowed to change this
    const files = listProductionSrcFiles();
    expect(files.length).toBeGreaterThan(0); // guard against a silent path-typo no-op
    expect(findEvalAndFunctionConstructorUsages(files)).toEqual([]);
  });

  it('no production src/** file outside src/shadow-cli/** has a literal dynamic import() specifier outside "./" / "../" / "node:" while the live lock is held (terra round G, G-1: a base64 data: URL passed to a real import() call is a literal, resolvable specifier, so the existing fail-closed "unresolvable specifier" rule never sees it -- this restricts literal dynamic import() targets to the only prefixes this repo has any legitimate reason to use)', () => {
    if (!isLiveLockLocked()) return; // the lock's own unlock PR is what's allowed to change this
    const files = listProductionSrcFiles();
    expect(files.length).toBeGreaterThan(0); // guard against a silent path-typo no-op
    expect(findDisallowedDynamicImportLiterals(files)).toEqual([]);
  });
});

describe("shadow-core import detector: self-test on synthetic files (terra review must-6 -- multiline import / dynamic import() / export-from)", () => {
  const tmpRoot = mkdtempSync(
    path.join(os.tmpdir(), "release-evidence-shadow-architecture-selftest-"),
  );

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** A relative specifier that genuinely resolves from `tmpRoot` to the REAL src/shadow/<module>,
   * computed dynamically so this self-test stays correct regardless of where the OS places its
   * temp directory. */
  function relativeSpecifierIntoShadowCore(moduleFile: string): string {
    return path.relative(tmpRoot, path.join(SHADOW_CORE_DIR, moduleFile));
  }

  function writeSyntheticFile(name: string, content: string): string {
    const filePath = path.join(tmpRoot, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  it("detects a multiline static import from src/shadow/**", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "multiline-import.ts",
      `import {\n  evaluate,\n} from "${spec}";\n`,
    );
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it("detects a dynamic import() of src/shadow/**", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "dynamic-import.ts",
      `export async function load() {\n  return import("${spec}");\n}\n`,
    );
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it("detects export ... from src/shadow/**", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile("export-from.ts", `export { evaluate } from "${spec}";\n`);
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it("detects a dynamic import() built from a template literal with a substitution (fail-closed -- the substituted path can't be resolved statically, so it is flagged regardless of what the literal chunks say)", () => {
    const file = writeSyntheticFile(
      "dynamic-template.ts",
      "export async function load(which: string) {\n  return import(`../shadow/${which}.js`);\n}\n",
    );
    expect(findShadowCoreImports([file]).length).toBeGreaterThan(0);
  });

  it("detects a dynamic import() built from a template literal with a substitution that names NO literal 'shadow' text at all (terra re-review round C: the old best-effort substring match would have missed this -- fail-closed flags it purely because it is unresolvable, not because of what it says)", () => {
    const file = writeSyntheticFile(
      "dynamic-template-innocuous-text.ts",
      "export async function load(which: string) {\n  return import(`../core/${which}.js`);\n}\n",
    );
    expect(findShadowCoreImports([file]).length).toBeGreaterThan(0);
  });

  it('detects a dynamic import() built from string concatenation (BinaryExpression, terra re-review round C: `import("../" + "shadow/evaluate.js")` was previously not analyzed as an expression shape at all and evaded detection entirely)', () => {
    const file = writeSyntheticFile(
      "dynamic-concat.ts",
      'export async function load() {\n  return import("../" + "shadow/evaluate.js");\n}\n',
    );
    expect(findShadowCoreImports([file]).length).toBeGreaterThan(0);
  });

  it("detects a dynamic import() of a bare variable (fail-closed: an import target this file cannot prove is NOT src/shadow/** must never be assumed safe)", () => {
    const file = writeSyntheticFile(
      "dynamic-variable.ts",
      "export async function load(modulePath: string) {\n  return import(modulePath);\n}\n",
    );
    expect(findShadowCoreImports([file]).length).toBeGreaterThan(0);
  });

  it("detects a CommonJS-compatible load of src/shadow/** via createRequire(import.meta.url) (fail-closed: terra round D's exact reproduction -- require()/createRequire() reach an entirely separate module loader that static/dynamic import detection alone cannot see, and Node 22 actually loads the module through it)", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "create-require.ts",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst shadow = load("${spec}");\n`,
    );
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it("detects an immediately-invoked createRequire(...)(...) chain that is never bound to a name at all", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "create-require-chained.ts",
      `import { createRequire } from "node:module";\nconst shadow = createRequire(import.meta.url)("${spec}");\n`,
    );
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it('detects createRequire loaded through a named-import alias (terra round E must-2 exact repro: `import { createRequire as cr } from "node:module"; const load = cr(import.meta.url);`)', () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "create-require-alias.ts",
      `import { createRequire as cr } from "node:module";\nconst load = cr(import.meta.url);\nconst shadow = load("${spec}");\n`,
    );
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it('detects createRequire reached via a namespace import (terra round E must-2: `import * as m from "node:module"`, then `m.createRequire(...)`)', () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "create-require-namespace.ts",
      `import * as m from "node:module";\nconst load = m.createRequire(import.meta.url);\nconst shadow = load("${spec}");\n`,
    );
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it("detects a bare global require(...) call (CommonJS-style, even inside a .ts file)", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile("bare-require.ts", `const shadow = require("${spec}");\n`);
    expect(findShadowCoreImports([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: spec },
    ]);
  });

  it("detects a createRequire(...)-bound identifier called with a non-literal argument (fail-closed: the same 'target this file cannot prove is safe' discipline dynamic import() already gets)", () => {
    const file = writeSyntheticFile(
      "create-require-variable.ts",
      'import { createRequire } from "node:module";\nexport function load(modulePath: string) {\n  const req = createRequire(import.meta.url);\n  return req(modulePath);\n}\n',
    );
    expect(findShadowCoreImports([file]).length).toBeGreaterThan(0);
  });

  it("does NOT flag createRequire(...) used to load something outside src/shadow/** (negative control -- the loaded target, not the mere presence of createRequire, is what matters)", () => {
    const spec = path.relative(tmpRoot, path.join(SRC_ROOT, "shadow-cli", "main.js"));
    const file = writeSyntheticFile(
      "create-require-unrelated.ts",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst cli = load("${spec}");\n`,
    );
    expect(findShadowCoreImports([file])).toEqual([]);
  });

  it("does NOT flag a relative import of src/shadow-cli/** (the one allowed importer -- a name-prefix collision, not the guarded directory)", () => {
    const spec = path.relative(tmpRoot, path.join(SRC_ROOT, "shadow-cli", "main.js"));
    const file = writeSyntheticFile("shadow-cli-import.ts", `import "${spec}";\n`);
    expect(findShadowCoreImports([file])).toEqual([]);
  });

  it("does NOT flag an unrelated import (negative control)", () => {
    const file = writeSyntheticFile("unrelated-import.ts", 'import { sep } from "node:path";\n');
    expect(findShadowCoreImports([file])).toEqual([]);
  });
});

describe("node:module supply-cut guard: self-test on synthetic files (terra round F -- computed property / destructuring / alias-copy evasions of round D/E's identifier tracking)", () => {
  const tmpRoot = mkdtempSync(
    path.join(os.tmpdir(), "release-evidence-shadow-architecture-supplycut-"),
  );

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function relativeSpecifierIntoShadowCore(moduleFile: string): string {
    return path.relative(tmpRoot, path.join(SHADOW_CORE_DIR, moduleFile));
  }

  function writeSyntheticFile(name: string, content: string): string {
    const filePath = path.join(tmpRoot, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  it('detects terra\'s computed-property evasion (`m["createRequire"]` never produces an identifier or property-access node named "createRequire" that round D/E\'s binding tracker looks for -- the round F fix does not need to: the `import * as m from "node:module"` statement itself is what trips it)', () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "computed-property.ts",
      `import * as m from "node:module";\nconst load = m["createRequire"](import.meta.url);\nconst shadow = load("${spec}");\n`,
    );
    expect(findNodeModuleSupplyUsages([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: "node:module" },
    ]);
  });

  it("detects terra's destructuring-with-rename evasion (`const { createRequire: cr } = ns` destructures off a plain object binding, not an import specifier, so round E's propertyName-based alias tracking never sees it -- round F trips on the underlying `import * as ns from \"node:module\"` instead)", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "destructure-rename.ts",
      `import * as ns from "node:module";\nconst { createRequire: cr } = ns;\nconst load = cr(import.meta.url);\nconst shadow = load("${spec}");\n`,
    );
    expect(findNodeModuleSupplyUsages([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: "node:module" },
    ]);
  });

  it("detects terra's plain alias-copy evasion (`const copied = imported` is an ordinary variable-to-variable assignment with no call expression at all, so it produces no node round D/E's `collectRequireBoundIdentifiers` -- which only follows `= createRequire(...)` call initializers -- ever inspects; round F trips on the original `import { createRequire } from \"node:module\"` regardless of how many plain aliases follow)", () => {
    const spec = relativeSpecifierIntoShadowCore("evaluate.js");
    const file = writeSyntheticFile(
      "alias-copy.ts",
      `import { createRequire } from "node:module";\nconst imported = createRequire;\nconst copied = imported;\nconst load = copied(import.meta.url);\nconst shadow = load("${spec}");\n`,
    );
    expect(findNodeModuleSupplyUsages([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: "node:module" },
    ]);
  });

  it('flags an import of "node:module" even for an export unrelated to createRequire (by design, not a gap: the supply-cut forbids the module specifier itself, not any particular named export, so it cannot be evaded by importing something other than createRequire)', () => {
    const file = writeSyntheticFile(
      "module-builtin-unrelated-export.ts",
      'import { builtinModules } from "node:module";\nexport const names = builtinModules;\n',
    );
    expect(findNodeModuleSupplyUsages([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), specifier: "node:module" },
    ]);
  });

  it("does NOT flag an unrelated import (negative control)", () => {
    const file = writeSyntheticFile("unrelated-import.ts", 'import { sep } from "node:path";\n');
    expect(findNodeModuleSupplyUsages([file])).toEqual([]);
  });
});

describe("terra round G self-test on synthetic files (G-2: process.getBuiltinModule / eval(import()) / base64 data: URL import -- the three routes terra's 6巡目 evaluator reproduced against round F's supply-cut)", () => {
  const tmpRoot = mkdtempSync(
    path.join(os.tmpdir(), "release-evidence-shadow-architecture-round-g-"),
  );

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSyntheticFile(name: string, content: string): string {
    const filePath = path.join(tmpRoot, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  it("detects terra's `process.getBuiltinModule(\"module\").createRequire(...)` route (no import statement for round F's supply-cut to see at all -- this is what actually loaded src/shadow/evaluate.js on Node 22 in terra's repro)", () => {
    const file = writeSyntheticFile(
      "get-builtin-module.ts",
      'const shadow = process.getBuiltinModule("module").createRequire(import.meta.url)("../shadow/evaluate.js");\n',
    );
    expect(findForbiddenIdentifierUsages([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), identifier: "getBuiltinModule" },
    ]);
  });

  it("detects terra's `eval('import(\"file:///.../shadow/evaluate.js\")')` route (a real import() call embedded in a string handed to eval -- invisible to collectModuleSpecifiers, which only walks actual import()/require AST nodes, never string literal contents)", () => {
    const file = writeSyntheticFile(
      "eval-import.ts",
      "const shadow = eval('import(\"file:///repo/src/shadow/evaluate.js\")');\n",
    );
    expect(findEvalAndFunctionConstructorUsages([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), identifier: "eval" },
    ]);
  });

  it("detects a `new Function(...)` constructor call the same way as eval (equally capable of returning code that reaches a dynamic import())", () => {
    const file = writeSyntheticFile(
      "new-function.ts",
      "const load = new Function(\"path\", 'return import(path)');\n",
    );
    expect(findEvalAndFunctionConstructorUsages([file])).toEqual([
      { file: path.relative(REPO_ROOT, file), identifier: "Function" },
    ]);
  });

  it("detects terra's base64 `data:` URL module route (a literal, resolvable import() specifier that the existing fail-closed 'unresolvable specifier' rule never flags because it IS resolvable -- it actually loaded src/shadow/evaluate.js on Node in terra's repro)", () => {
    const encoded = Buffer.from(
      'export * from "file:///repo/src/shadow/evaluate.js";',
      "utf-8",
    ).toString("base64");
    const file = writeSyntheticFile(
      "data-url-import.ts",
      `export async function load() {\n  return import("data:text/javascript;base64,${encoded}");\n}\n`,
    );
    expect(findDisallowedDynamicImportLiterals([file])).toEqual([
      {
        file: path.relative(REPO_ROOT, file),
        specifier: `data:text/javascript;base64,${encoded}`,
      },
    ]);
  });

  it("does NOT flag a relative dynamic import() (negative control -- the only literal shape production code actually needs)", () => {
    const file = writeSyntheticFile(
      "relative-dynamic-import.ts",
      'export async function load() {\n  return import("./sibling.js");\n}\n',
    );
    expect(findDisallowedDynamicImportLiterals([file])).toEqual([]);
  });

  it("does NOT flag a node:-prefixed dynamic import() other than node:module/module (negative control)", () => {
    const file = writeSyntheticFile(
      "node-builtin-dynamic-import.ts",
      'export async function load() {\n  return import("node:path");\n}\n',
    );
    expect(findDisallowedDynamicImportLiterals([file])).toEqual([]);
  });

  it("does NOT flag a bare-package STATIC import (negative control: G-1's dynamic-import literal restriction must not reach static imports, which legitimately use bare npm package specifiers)", () => {
    const file = writeSyntheticFile("static-package-import.ts", 'import ts from "typescript";\n');
    expect(findDisallowedDynamicImportLiterals([file])).toEqual([]);
  });

  it("does NOT flag unrelated code for getBuiltinModule/eval/Function (negative control)", () => {
    const file = writeSyntheticFile(
      "unrelated.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    expect(findForbiddenIdentifierUsages([file])).toEqual([]);
    expect(findEvalAndFunctionConstructorUsages([file])).toEqual([]);
  });
});
