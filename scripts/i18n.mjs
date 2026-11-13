#!/usr/bin/env node
/**
 * Translation upkeep (packages/core/src/i18n). Reads the code with the TypeScript compiler.
 *
 *   node scripts/i18n.mjs report [paths...]   English still typed straight into the screens, by file
 *                                             (default: the screens a crew uses, COVERED below)
 *   node scripts/i18n.mjs missing             t()/msg()/<T> text with no Spanish line, as catalog lines to fill in
 *   node scripts/i18n.mjs wrap <files...>     wraps the plain cases in t() and lists the rest
 *                                             (sentences built around {values} or <links>) for a person
 *
 * The tests use the same reading: packages/core/test/i18n.test.ts (every line has its Spanish) and
 * apps/web/test/i18nCoverage.test.ts (the covered screens have no English typed outside t()).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_DIR = "packages/core/src/i18n/es";
/** Catalog files that hold pattern tables (patterns.ts) rather than t() lines. */
const PATTERN_FILES = new Set(["index.ts", "notices.ts", "errors.ts"]);

/**
 * The screens a team member works in, which must have no English outside t() (Español is offered
 * for these). Office screens are left for later: see docs/spanish-support-plan.md.
 */
export const COVERED = [];

/** Where t()/msg()/<T> text is read from. */
const SOURCES = ["apps/web/src", "apps/api/src", "packages/core/src"];

/** Props whose text people read. */
const TEXT_PROPS = new Set([
  "label", "title", "placeholder", "aria-label", "alt", "hint", "description", "emptyText", "confirmLabel", "cancelLabel",
  "subtitle", "caption", "help", "tooltip", "message", "heading", "actionLabel", "empty", "aria-description", "aria-valuetext", "note",
  "eyebrow", "detail", "summary", "doneLabel", "saveLabel", "submitLabel", "busyLabel", "addLabel", "lede",
]);
/** Object keys whose text people read (toasts' meta, confirm()'s question, a menu's items). */
const TEXT_KEYS = new Set(["success", "error", "title", "body", "message", "label", "hint", "description", "confirmLabel", "cancelLabel", "placeholder", "empty", "note", "detail"]);
/** Calls whose string arguments people read. */
const TEXT_CALLS = /^(toast(\.\w+)?|alert|window\.alert|window\.confirm|window\.prompt|new Error)$/;
/** Text that reads the same in every language. */
const SAME_EVERYWHERE = new Set(["Crewtavo", "Google", "Apple", "Android", "iPhone", "iPad", "Stripe", "Railway", "Claude", "PDF", "SMS", "GPS", "Email", "OK"]);

const isTranslateCall = (node) =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && (node.expression.text === "t" || node.expression.text === "msg")) ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "plural" && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "t"));

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);
const insideFunction = (node) => {
  for (let n = node.parent; n; n = n.parent) if (FUNCTION_KINDS.has(n.kind)) return true;
  return false;
};
const insideTranslate = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (isTranslateCall(n)) return true;
    if (ts.isJsxAttribute(n) && n.name.getText() === "text" && ts.isJsxSelfClosingElement(n.parent.parent) && n.parent.parent.tagName.getText() === "T") return true;
  }
  return false;
};

export function parse(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

export function listFiles(paths) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name));
    } else if (/\.(ts|tsx)$/.test(rel) && !rel.endsWith(".d.ts") && !rel.endsWith("database.types.ts")) out.push(rel);
  };
  paths.forEach(walk);
  return out;
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const stringValue = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
export const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
export const tags = (text) => [...new Set([...text.matchAll(/<(\w+)>/g)].map((m) => m[1]))].sort();

/**
 * Every translated text in a file: { file, line, kind ("t" | "plural" | "msg" | "T"), key, english,
 * forms (plurals) } and problems (t() of a sentence built with ${}, t() run before the language is known).
 */
export function keysIn(file) {
  const sf = parse(file);
  const keys = [];
  const problems = [];
  const objectProp = (obj, name) => obj && ts.isObjectLiteralExpression(obj) ? obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === name) : undefined;
  const visit = (node) => {
    if (isTranslateCall(node)) {
      const callee = node.expression.getText(sf);
      const line = lineOf(sf, node);
      if (callee !== "msg" && !insideFunction(node)) problems.push({ file, line, problem: `${callee}() runs as the file loads, before the language is known: use msg() there and t() where it's shown` });
      if (callee === "t.plural") {
        const forms = node.arguments[1];
        const one = stringValue(objectProp(forms, "one")?.initializer);
        const other = stringValue(objectProp(forms, "other")?.initializer);
        const context = stringValue(objectProp(node.arguments[2], "context")?.initializer);
        if (one == null || other == null) problems.push({ file, line, problem: "t.plural() needs { one, other } written out as text" });
        else keys.push({ file, line, kind: "plural", key: context ? `${context}::${other}` : other, english: other, forms: { one, other } });
      } else {
        const first = node.arguments[0];
        const value = stringValue(first);
        if (first && ts.isTemplateExpression(first)) problems.push({ file, line, problem: `${callee}() of a sentence built with \${}: write {placeholders} and pass their values` });
        if (value != null) {
          const context = callee === "msg" ? stringValue(node.arguments[1]) : stringValue(objectProp(node.arguments[1], "context")?.initializer);
          keys.push({ file, line, kind: callee === "msg" ? "msg" : "t", key: context ? `${context}::${value}` : value, english: value });
          const params = node.arguments[1];
          if (callee === "t" && placeholders(value).length && !(params && ts.isObjectLiteralExpression(params))) {
            problems.push({ file, line, problem: `"${value}" has {placeholders} but no values` });
          } else if (callee === "t" && params && ts.isObjectLiteralExpression(params) && !params.properties.some((p) => ts.isSpreadAssignment(p))) {
            const given = new Set(params.properties.map((p) => p.name?.getText(sf).replace(/["']/g, "")));
            for (const name of placeholders(value)) if (!given.has(name)) problems.push({ file, line, problem: `"${value}" has {${name}} but no value for it` });
          }
        }
      }
    } else if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === "T") {
      const attr = node.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "text");
      const value = attr && (stringValue(attr.initializer) ?? (attr.initializer && ts.isJsxExpression(attr.initializer) ? stringValue(attr.initializer.expression) : null));
      if (value != null) keys.push({ file, line: lineOf(sf, node), kind: "T", key: value, english: value });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { keys, problems };
}

export function allKeys(paths = SOURCES) {
  const keys = [];
  const problems = [];
  for (const file of listFiles(paths)) {
    if (file.startsWith("packages/core/src/i18n/")) continue;
    const found = keysIn(file);
    keys.push(...found.keys);
    problems.push(...found.problems);
  }
  return { keys, problems };
}

/** The Spanish catalog as written: { key: { value, file, line } }, and keys written twice. */
export function readCatalog() {
  const lines = new Map();
  const duplicates = [];
  for (const name of fs.readdirSync(path.join(ROOT, CATALOG_DIR)).sort()) {
    if (!name.endsWith(".ts") || PATTERN_FILES.has(name)) continue;
    const file = `${CATALOG_DIR}/${name}`;
    const sf = parse(file);
    // export default { ... } satisfies Catalog;
    let object = sf.statements.find((s) => ts.isExportAssignment(s))?.expression;
    while (object && (ts.isSatisfiesExpression(object) || ts.isAsExpression(object) || ts.isParenthesizedExpression(object))) object = object.expression;
    if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${file} should end its lines with: export default { ... } satisfies Catalog;`);
    for (const node of object.properties) {
      if (!ts.isPropertyAssignment(node)) continue;
      const key = ts.isStringLiteral(node.name) || ts.isNoSubstitutionTemplateLiteral(node.name) ? node.name.text : node.name.getText(sf);
      let value = stringValue(node.initializer);
      if (value == null && ts.isObjectLiteralExpression(node.initializer)) {
        value = {};
        for (const p of node.initializer.properties) if (ts.isPropertyAssignment(p)) value[p.name.getText(sf)] = stringValue(p.initializer);
      }
      if (lines.has(key)) duplicates.push({ key, file, other: lines.get(key).file });
      lines.set(key, { value, file, line: lineOf(sf, node) });
    }
  }
  return { lines, duplicates };
}

/** What's wrong between the code and the catalog: each a sentence with where. */
export function catalogProblems() {
  const { keys, problems } = allKeys();
  const { lines, duplicates } = readCatalog();
  const out = problems.map((p) => `${p.file}:${p.line} ${p.problem}`);
  for (const d of duplicates) out.push(`${d.file}: "${d.key}" is also in ${d.other}`);
  const used = new Set();
  for (const k of keys) {
    used.add(k.key);
    const line = lines.get(k.key);
    const where = `${k.file}:${k.line}`;
    if (!line) {
      out.push(`${where} no Spanish for "${k.key}"`);
      continue;
    }
    if (k.kind === "plural") {
      if (typeof line.value !== "object" || !line.value.one || !line.value.other) {
        out.push(`${where} "${k.key}" is a plural: its Spanish needs { one, other }`);
        continue;
      }
      const english = new Set([...placeholders(k.forms.one), ...placeholders(k.forms.other), "count"]);
      for (const form of ["one", "other", "many"]) {
        const text = line.value[form];
        if (!text) continue;
        const extra = placeholders(text).filter((p) => !english.has(p));
        if (extra.length) out.push(`${line.file}:${line.line} "${k.key}" (${form}) has {${extra.join("}, {")}}, which the English doesn't`);
      }
      const missing = placeholders(k.forms.other).filter((p) => !placeholders(line.value.other).includes(p));
      if (missing.length) out.push(`${line.file}:${line.line} "${k.key}" lost {${missing.join("}, {")}} in Spanish`);
    } else {
      if (typeof line.value !== "string") {
        out.push(`${where} "${k.key}" isn't a plural, but its Spanish is written as one`);
        continue;
      }
      if (placeholders(k.english).join() !== placeholders(line.value).join()) out.push(`${line.file}:${line.line} "${k.key}": the {placeholders} differ from the English`);
      if (tags(k.english).join() !== tags(line.value).join()) out.push(`${line.file}:${line.line} "${k.key}": the <tags> differ from the English`);
    }
  }
  for (const [key, line] of lines) if (!used.has(key)) out.push(`${line.file}:${line.line} "${key}" isn't used anywhere any more`);
  return out;
}

const cleanJsxText = (value) => {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((l, i) => {
    if (/[^ \t]/.test(l)) lastNonEmpty = i;
  });
  let out = "";
  lines.forEach((line, i) => {
    let s = line.replace(/\t/g, " ");
    if (i !== 0) s = s.replace(/^ +/, "");
    if (i !== lines.length - 1) s = s.replace(/ +$/, "");
    if (s) out += i === lastNonEmpty ? s : `${s} `;
  });
  return out;
};
const ENTITIES = { nbsp: " ", amp: "&", apos: "'", quot: '"', rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…", times: "×", middot: "·", lt: "<", gt: ">", larr: "←", rarr: "→" };
const decode = (text) => text.replace(/&(\w+);/g, (whole, name) => ENTITIES[name] ?? whole);

const readable = (text) => {
  const s = text.trim();
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (SAME_EVERYWHERE.has(s)) return false;
  return true;
};
const ignored = (sf, node) => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sf.text.split("\n");
  return /i18n-ignore/.test(lines[line] ?? "") || /i18n-ignore/.test(lines[line - 1] ?? "");
};

/** Whether a JSX child list reads as one sentence around values or links (left for a person). */
const meaningfulText = (node) => {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxText(n) && readable(decode(cleanJsxText(n.text)))) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
};
const mixedSentence = (text) => {
  const siblings = text.parent.children ?? [];
  return siblings.some((s) => s !== text && ((ts.isJsxExpression(s) && s.expression) || ((ts.isJsxElement(s) || ts.isJsxText(s)) && meaningfulText(s))));
};

/**
 * English typed outside t() in a file: { line, text, kind, fix } where fix (when set) is the
 * replacement the wrap command makes: [start, end, newText].
 */
export function rawStrings(file) {
  const sf = parse(file);
  const found = [];
  const add = (node, text, kind, fix) => {
    if (ignored(sf, node)) return;
    found.push({ line: lineOf(sf, node), text, kind, fix });
  };
  const wrapLiteral = (lit) => [lit.getStart(sf), lit.getEnd(), `${insideFunction(lit) ? "t" : "msg"}(${JSON.stringify(lit.text)})`];
  /** String leaves of `a ? "x" : "y"`, `a && "x"`, `a ?? "x"`, or the string itself. */
  const leaves = (expr) => {
    if (!expr) return [];
    if (ts.isParenthesizedExpression(expr)) return leaves(expr.expression);
    if (ts.isConditionalExpression(expr)) return [...leaves(expr.whenTrue), ...leaves(expr.whenFalse)];
    if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) return leaves(expr.right);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) return [expr];
    return [];
  };
  const literalLeaves = (expr, kind) => {
    for (const leaf of leaves(expr)) {
      if (insideTranslate(leaf)) continue;
      if (ts.isTemplateExpression(leaf)) {
        if (/[A-Za-z]{2,}/.test(leaf.getText(sf).replace(/\$\{[^}]*\}/g, ""))) add(leaf, leaf.getText(sf), `${kind} (built with \${})`);
      } else if (readable(leaf.text)) add(leaf, leaf.text, kind, wrapLiteral(leaf));
    }
  };
  const visit = (node) => {
    if (isTranslateCall(node)) return;
    if (ts.isJsxText(node)) {
      const text = decode(cleanJsxText(node.text));
      if (readable(text) && !insideTranslate(node)) {
        const clean = text === text.trim() && !/&\w+;/.test(text);
        const mixed = mixedSentence(node);
        add(node, text, mixed ? "sentence around values or links" : "text", !mixed && clean ? [node.getStart(sf), node.getEnd(), `{t(${JSON.stringify(text)})}`] : undefined);
      }
    } else if (ts.isJsxAttribute(node) && TEXT_PROPS.has(node.name.getText(sf))) {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init) && readable(init.text)) add(init, init.text, `${node.name.getText(sf)}=`, [init.getStart(sf), init.getEnd(), `{t(${JSON.stringify(init.text)})}`]);
      else if (init && ts.isJsxExpression(init)) literalLeaves(init.expression, `${node.name.getText(sf)}=`);
      return;
    } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      literalLeaves(node.expression, "text");
    } else if (ts.isPropertyAssignment(node) && TEXT_KEYS.has(node.name.getText(sf).replace(/["']/g, ""))) {
      literalLeaves(node.initializer, `${node.name.getText(sf)}:`);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = `${ts.isNewExpression(node) ? "new " : ""}${node.expression.getText(sf)}`;
      if (TEXT_CALLS.test(callee)) for (const arg of node.arguments ?? []) literalLeaves(arg, `${callee}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Applies rawStrings' fixes to a file and adds the import; returns what's left for a person. */
export function wrapFile(file) {
  const items = rawStrings(file);
  const fixes = items.filter((i) => i.fix).map((i) => i.fix).sort((a, b) => b[0] - a[0]);
  let text = fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const [start, end, replacement] of fixes) text = text.slice(0, start) + replacement + text.slice(end);
  const needs = ["t", "msg"].filter((name) => fixes.some((f) => f[2].startsWith(`${name}(`) || f[2].startsWith(`{${name}(`)));
  if (needs.length) text = addImport(text, file, needs);
  fs.writeFileSync(path.join(ROOT, file), text);
  return items.filter((i) => !i.fix);
}

function addImport(text, file, names) {
  const from = file.startsWith("apps/web/") ? "@/lib/i18n" : "@crewtavo/core/i18n";
  const existing = text.match(new RegExp(`import \\{([^}]*)\\} from "${from.replace(/[/@]/g, "\\$&")}";`));
  if (existing) {
    const have = existing[1].split(",").map((s) => s.trim()).filter(Boolean);
    const all = [...new Set([...have, ...names])].sort();
    return text.replace(existing[0], `import { ${all.join(", ")} } from "${from}";`);
  }
  const imports = [...text.matchAll(/^import [\s\S]*? from ["'][^"']+["'];?$/gm)];
  const at = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : 0;
  return `${text.slice(0, at)}\nimport { ${names.sort().join(", ")} } from "${from}";${text.slice(at)}`;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "report") {
    let total = 0;
    for (const file of listFiles(args.length ? args : COVERED)) {
      const items = rawStrings(file);
      if (!items.length) continue;
      total += items.length;
      console.log(`\n${file} (${items.length})`);
      for (const i of items) console.log(`  ${i.line}: [${i.kind}] ${i.text}`);
    }
    console.log(`\n${total} English strings outside t()`);
  } else if (command === "missing") {
    const { keys } = allKeys();
    const { lines } = readCatalog();
    const byFile = new Map();
    for (const k of keys) if (!lines.has(k.key)) byFile.set(k.file, [...(byFile.get(k.file) ?? []), k]);
    const seen = new Set();
    for (const [file, list] of byFile) {
      const fresh = list.filter((k) => !seen.has(k.key) && seen.add(k.key));
      if (!fresh.length) continue;
      console.log(`  // ${file}`);
      for (const k of fresh) console.log(k.kind === "plural" ? `  ${JSON.stringify(k.key)}: { one: ${JSON.stringify(k.forms.one)}, other: ${JSON.stringify(k.forms.other)} },` : `  ${JSON.stringify(k.key)}: "",`);
    }
    console.log(`\n// ${seen.size} without Spanish`);
  } else if (command === "wrap") {
    for (const file of args) {
      const left = wrapFile(file);
      if (left.length) console.log(`\n${file} (${left.length} left)`);
      for (const i of left) console.log(`  ${i.line}: [${i.kind}] ${i.text}`);
    }
  } else if (command === "check") {
    const problems = catalogProblems();
    problems.forEach((p) => console.log(p));
    console.log(`\n${problems.length} problems`);
    process.exitCode = problems.length ? 1 : 0;
  } else {
    console.log("node scripts/i18n.mjs report [paths...] | missing | check | wrap <files...>");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
