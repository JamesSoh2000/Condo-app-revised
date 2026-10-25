/**
 * P5-05 criterion 11, the P3-05 fitness test: a component that reads the building passively
 * (`useBuilding({ passive: true })`) shows what the guards loaded, and a refetch that fails keeps the old `data`. Once
 * the building is denied (a 401 or 404 on any of its requests, app/buildingDenial.ts), that data must not be shown,
 * so the same function must also read `useBuildingDenied()`, itself or through a hook that does (`useCanViewAs`), or
 * be exempt below with the reason.
 *
 * Read with the TypeScript checker, not text matching or name tables (CLAUDE.md lessons; P6-02a, the P5-05 round-3
 * follow-up): each call's callee is resolved to the function it names through the checker's symbols, following
 * imports, namespace members, `const` aliases, destructuring and wrappers (`memo(() => …)`), so scope, shadowing and
 * renames are the language's own. An import the program can't follow keeps the name it is exported by, as the P5-05
 * inspector did. Only a binding that can't change earns the denial: an import or namespace member, a `const` alias, a
 * function declaration never reassigned, an anonymous function (named ones go by their own name), or the one React's
 * `memo` or `forwardRef` is given first. Any
 * other value (a `let`, an object's member or method, a call's result) earns nothing, and counts as `useBuilding` if
 * it may be it, by its name or its contents (fail-closed: it can only add a passive reader; P6-02a review rounds 1–2).
 * An argument it can't read counts as passive (fail-closed).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
/** Where the two hooks the rule is about are defined, by their path under src. */
const PROVIDER = 'app/BuildingProvider.tsx';

/** `<path under src>::<function>` → why it may read the building passively without reading the denial. */
const EXEMPT: Record<string, string> = {
  'app/BuildingProvider.tsx::useBuildingDenied': 'It is the denial: it reads the building to compare the denial with its last answer.',
  'features/packages/WaitingList.tsx::WaitingList':
    'Rendered only by SecurityPackagesPage, a route under RequireActiveMembership → BuildingLoaded, which renders the ' +
    'denial screen instead of its children once useBuildingDenied() is true (app/guards.tsx).',
  'features/packages/pages/MyPackagesPage.tsx::Packages':
    'Rendered only by MyPackagesPage, a route under RequireActiveMembership → BuildingLoaded, which renders the denial ' +
    'screen instead of its children once useBuildingDenied() is true (app/guards.tsx).',
  'features/notices/NoticesPage.tsx::Notices':
    'Rendered only by NoticesPage, a route under RequireActiveMembership → BuildingLoaded, which renders the denial ' +
    'screen instead of its children once useBuildingDenied() is true (app/guards.tsx).',
  'features/notices/ManagerNoticesPage.tsx::ManagerNotices':
    'Rendered only by ManagerNoticesPage, a route under RequireActiveMembership → BuildingLoaded, which renders the ' +
    'denial screen instead of its children once useBuildingDenied() is true (app/guards.tsx).',
};

interface Fn {
  /** `<path under src>::<name>`, as in `EXEMPT`. */
  id: string;
  /** The function itself, as the calls that resolve to it name it: its file and position. */
  key: string;
  /** It calls `useBuilding` with `passive: true`, or with an argument it can't read. */
  passive: boolean;
  /** The keys of the hooks it calls: resolved functions, or `<unresolved>::<name>`. */
  calls: Set<string>;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const underSrc = (file: string) => relative(SRC, file).split(sep).join('/');

/**
 * A program over `files` (absolute path → source), resolving `@/…` as the app's tsconfig does. Only these files: no
 * libraries and no other imports are read (`noLib`, `noResolve`), so a name from React or a missing module stays
 * unresolved, which the rule treats as above. Binding the names needs no types.
 */
function program(files: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    baseUrl: join(SRC, '..'),
    paths: { '@/*': ['src/*'] },
    noLib: true,
    noResolve: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (path) => files.has(path);
  host.readFile = (path) => files.get(path);
  host.directoryExists = () => true;
  host.getSourceFile = (path, language) => {
    const text = files.get(path);
    return text === undefined ? undefined : ts.createSourceFile(path, text, language, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  };
  return ts.createProgram([...files.keys()], options, host);
}

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFunction(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

/**
 * A function's name: its own, else the variable it is assigned to, through any wrapping calls (`const A = memo(() =>
 * …)`), `default` for a default export, else `<anonymous@line>`. Never a name shared with another function (review
 * round 1, Claude M1: wrapped and anonymous components all became one `<module>`).
 */
function functionName(fn: FunctionNode): string {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) return fn.name.text;
  if (ts.isFunctionDeclaration(fn) && fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return 'default';
  let at: ts.Node = fn.parent;
  while (ts.isCallExpression(at) || ts.isParenthesizedExpression(at) || ts.isAsExpression(at)) at = at.parent;
  if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
  if (ts.isExportAssignment(at)) return 'default';
  const { line } = fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart());
  return `<anonymous@${line + 1}>`;
}

const keyOf = (fn: FunctionNode) => `${underSrc(fn.getSourceFile().fileName)}@${fn.getStart()}`;

/** The function a hook call runs in: the nearest one around it, since hooks run in a component's or hook's own body. */
function owner(node: ts.Node): FunctionNode | undefined {
  for (let at = node.parent; at; at = at.parent) if (isFunction(at)) return at;
  return undefined;
}

/** An expression without the wrappers that don't change which function it is: `(f)`, `f!`, `f as T`, `f satisfies T`. */
function unwrap(expression: ts.Expression): ts.Expression {
  let at = expression;
  while (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) {
    at = at.expression;
  }
  return at;
}

/** What a callee names: a function in the program, or a name the checker can't follow to one. */
type Target = { fn: FunctionNode } | { unresolved: string };

/**
 * The name an unresolved callee goes by: an identifier's, a member's, `<computed>` for `x[name]` (which may be any
 * hook), or `<other>` for a shape that names no hook (`super(…)`, `f()(…)`), as before the checker.
 */
function nameOf(expression: ts.Expression): string {
  const at = unwrap(expression);
  if (ts.isIdentifier(at)) return at.text;
  if (ts.isPropertyAccessExpression(at)) return at.name.text;
  if (ts.isElementAccessExpression(at)) {
    const arg = at.argumentExpression;
    return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : '<computed>';
  }
  return '<other>';
}

/** The global object's names: written through, they can replace a global `memo`. */
const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);
const isWrapperName = (name: string) => name === 'memo' || name === 'forwardRef';

/** True if `node` names a member or declares something (`x.self`, `{ self: 1 }`, `self: boolean`), not a reference to a binding. */
function isMemberOrDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  return parent.name === node || parent.propertyName === node;
}

/** True if `node` is written, not only read: an assignment's target (destructuring included), `delete`, `++`, `--`. */
function isWritten(node: ts.Node): boolean {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isAsExpression(at.parent)) at = at.parent;
  const parent = at.parent;
  if (ts.isBinaryExpression(parent) && parent.left === at) {
    const kind = parent.operatorToken.kind;
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isDeleteExpression(parent)) return true;
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  // `({ memo: x.memo } = …)`, `[x.memo] = …`: a member inside a destructuring assignment's target.
  for (let up: ts.Node = parent; up && !ts.isStatement(up); up = up.parent) {
    if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.left.pos <= at.pos && at.end <= up.left.end) {
      return ts.isObjectLiteralExpression(up.left) || ts.isArrayLiteralExpression(up.left);
    }
  }
  return false;
}

function resolver(checker: ts.TypeChecker, files: readonly ts.SourceFile[], isBuilding: (fn: FunctionNode) => boolean) {
  /**
   * The function a value expression is, through wrappers, aliases and the checker's symbols. `name` is what it goes by
   * if it is no function the checker can follow: a variable's own name for its value (`const navigate =
   * useNavigate()`), else the expression's; but `useBuilding` if the value may be it (`mayBeBuilding`, fail-closed:
   * P6-02a review round 1, Codex F1 and F2).
   */
  const ofExpression = (expression: ts.Expression, seen: Set<ts.Symbol>, name = nameOf(expression)): Target => {
    const at = unwrap(expression);
    // A named function expression is known by its own name, as the P5-05 inspector knew it, so the variable or wrapper
    // it is given to earns nothing from it (round 3: the fix's differential run).
    if (ts.isArrowFunction(at) || (ts.isFunctionExpression(at) && !at.name)) return { fn: at };
    const unknown = (): Target => ({ unresolved: mayBeBuilding(at, seen) ? 'useBuilding' : name });
    // A function wrapped by React's `memo` or `forwardRef`, which keep it: their first argument, written inline or
    // itself wrapped. `memo`'s second is its comparison, not what it returns (round 3, Codex F2). Any other call may
    // return anything, and a function only passed in by name may not be what it returns (review round 1, Codex F2;
    // round 2, Codex F1): unknown.
    if (ts.isCallExpression(at)) {
      const inner = at.arguments[0] && unwrap(at.arguments[0]);
      if (!inner || !isReactWrapper(unwrap(at.expression))) return unknown();
      if (!(ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isCallExpression(inner))) return unknown();
      const found = ofExpression(inner, seen);
      return 'fn' in found ? found : unknown();
    }
    if (!ts.isIdentifier(at) && !ts.isPropertyAccessExpression(at) && !ts.isElementAccessExpression(at)) return unknown();
    let node: ts.Node = at;
    if (ts.isPropertyAccessExpression(at)) node = at.name;
    else if (ts.isElementAccessExpression(at)) node = at.argumentExpression;
    const symbol = checker.getSymbolAtLocation(node);
    return symbol ? ofSymbol(symbol, seen, name) : unknown();
  };

  /** The import from `react` that declares `node`'s symbol (`{ memo }`, `* as React`, `React`), if it is one. */
  const reactImport = (node: ts.Node): ts.ImportSpecifier | ts.NamespaceImport | ts.ImportClause | undefined => {
    const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
    if (!declaration || !(ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration))) return undefined;
    let at: ts.Node = declaration;
    while (!ts.isImportDeclaration(at)) at = at.parent;
    return ts.isStringLiteral(at.moduleSpecifier) && at.moduleSpecifier.text === 'react' ? declaration : undefined;
  };

  /**
   * Whether React's functions, or a global `memo`, may have been replaced anywhere in the program (round 3, Codex F2):
   * a write to a member named `memo` or `forwardRef` on anything, a write to a computed member of React or the global
   * object, or React or the global object used other than read by name (`React.memo`, `typeof window`), which may
   * reach a write the test can't see (`Object.assign(React, …)`, `const R = React`). React's named exports read its
   * default export's object under the bundler's interop, so one write ends the trust in every form.
   */
  const patchable = files.some((file) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = nameOf(node);
        if (isWritten(node) && (isWrapperName(member) || (member === '<computed>' && isReactOrGlobal(node.expression)))) found = true;
      } else if (ts.isIdentifier(node) && isReactOrGlobal(node) && !isReadByName(node)) {
        found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  });

  /**
   * True if `node` is React's module object (a default or namespace import of `react`) or the global object: a
   * reference to it, not a member or a declaration that shares its name (`variables.self`, `{ self: true }`).
   */
  function isReactOrGlobal(node: ts.Node): boolean {
    if (!ts.isIdentifier(node)) return false;
    const imported = reactImport(node);
    if (imported) return !ts.isImportSpecifier(imported);
    if (!GLOBALS.has(node.text) || isMemberOrDeclarationName(node)) return false;
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
    return declarations.every((d) => !files.includes(d.getSourceFile()));
  }

  /** True if `node` is only read by name: `X.name` (not written), `typeof X`, a type, or its own import. */
  function isReadByName(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return !isWritten(parent);
    if (ts.isTypeOfExpression(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
    for (let at: ts.Node = node; at.parent; at = at.parent) if (ts.isTypeNode(at) || ts.isQualifiedName(at)) return true;
    return false;
  }

  /**
   * React's `memo` or `forwardRef`, while nothing can have replaced it (`patchable`): imported from `react` by its name
   * or through the namespace import, never its mutable default export (round 3, Codex F2), or a global of that name that
   * nothing in the program declares (the inspector's cases; `noLib` leaves React's own types out).
   */
  const isReactWrapper = (callee: ts.Expression): boolean => {
    if (patchable) return false;
    if (ts.isIdentifier(callee)) {
      if (checker.getSymbolAtLocation(callee) === undefined) return isWrapperName(callee.text);
      const imported = reactImport(callee);
      return !!imported && ts.isImportSpecifier(imported) && isWrapperName((imported.propertyName ?? imported.name).text);
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const imported = reactImport(callee.expression);
      return isWrapperName(callee.name.text) && !!imported && ts.isNamespaceImport(imported);
    }
    return false;
  };

  /** True if `target` is `useBuilding`, or a value the checker couldn't follow that may be it. */
  const isBuildingTarget = (target: Target) => ('fn' in target ? isBuilding(target.fn) : target.unresolved === 'useBuilding');

  /**
   * Whether a value the checker can't follow may be `useBuilding`: it, or a name or member inside it (a factory's
   * argument, a branch of a conditional), resolves to it. Fail-closed, as the name rule for unresolved callees: it can
   * only add a passive reader. Never asked of the denial: an unknown value earns no denial.
   */
  const mayBeBuilding = (expression: ts.Node, seen: Set<ts.Symbol>): boolean => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : ts.isElementAccessExpression(node) ? node.argumentExpression : node);
        if (symbol && isBuildingTarget(ofSymbol(symbol, new Set(seen), nameOf(node)))) {
          found = true;
          return;
        }
        if (!symbol && nameOf(node) === 'useBuilding') {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };

  const ASSIGNMENTS = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);

  /** Each value assigned to the binding `symbol` in its file (`=`, `||=`, `&&=`, `??=`); a module binding can't be assigned elsewhere. */
  const assignedTo = (symbol: ts.Symbol, declaration: ts.Node): ts.Expression[] => {
    const values: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        ASSIGNMENTS.has(node.operatorToken.kind) &&
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === symbol
      ) {
        values.push(node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.getSourceFile());
    return values;
  };

  /** What a binding that can change is: never a function, `useBuilding` if any of its values may be (fail-closed). */
  const changeable = (values: ts.Expression[], seen: Set<ts.Symbol>, name: string): Target => ({
    unresolved: values.some((value) => isBuildingTarget(ofExpression(value, new Set(seen), name))) ? 'useBuilding' : name,
  });

  /**
   * The function a symbol stands for: its declaration, followed through imports, `const` aliases and destructuring, as
   * long as the binding can't change; otherwise unresolved (see the file's comment).
   */
  const ofSymbol = (start: ts.Symbol, seen: Set<ts.Symbol>, name: string): Target => {
    // An import, re-export or namespace member: the checker follows the whole chain; one it can't is its unknown symbol,
    // with no declaration. That one goes by the last name the chain exports it as, not the local one (`useBuilding as
    // read` is `useBuilding`), as the P5-05 inspector named imports (round 3, Codex F1).
    const symbol = start.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(start) : start;
    if (seen.has(symbol)) return { unresolved: name };
    seen.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return { unresolved: start.flags & ts.SymbolFlags.Alias ? exportedName(start, name) : name };
    if (ts.isFunctionDeclaration(declaration)) {
      // A function declaration is a binding too: reassigned anywhere in its file, it may not be what runs (round 2, Codex F2).
      const values = assignedTo(symbol, declaration);
      return values.length === 0 ? { fn: declaration } : changeable(values, seen, name);
    }
    // An object's or a class's method can be replaced (`hooks.useCan = …`): it earns nothing (round 2, Codex F2).
    if (ts.isMethodDeclaration(declaration)) return { unresolved: name };
    if (isFunction(declaration)) return { fn: declaration };
    if (ts.isVariableDeclaration(declaration)) {
      // Only a `const` keeps its value. A `let` or `var` may be reassigned, so it is no function and earns no denial;
      // it is `useBuilding` if any value it is given may be (review round 1, Codex F1).
      const list = declaration.parent;
      const constant = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      if (constant && declaration.initializer) return ofExpression(declaration.initializer, seen, name);
      return changeable([...(declaration.initializer ? [declaration.initializer] : []), ...assignedTo(symbol, declaration)], seen, name);
    }
    if (ts.isParameter(declaration)) {
      // A parameter is what the caller passes; its default may be `useBuilding` (fail-closed).
      return { unresolved: declaration.initializer && mayBeBuilding(declaration.initializer, seen) ? 'useBuilding' : name };
    }
    if (ts.isBindingElement(declaration)) {
      // `const { useBuilding: ub } = Building`: the member of what is destructured.
      const pattern = declaration.parent;
      const holder = pattern.parent;
      const property = declaration.propertyName ?? declaration.name;
      const member = ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : '<computed>';
      const constant = ts.isVariableDeclaration(holder) && ts.isVariableDeclarationList(holder.parent) && (holder.parent.flags & ts.NodeFlags.Const) !== 0;
      if (!constant || !ts.isObjectBindingPattern(pattern) || !holder.initializer) return { unresolved: member };
      const found = checker.getTypeAtLocation(holder.initializer).getProperty(member);
      return found ? ofSymbol(found, seen, member) : { unresolved: member };
    }
    // An object's member can be replaced (`hooks.useBuildingDenied = …`), even in a `const` object: it earns nothing,
    // and is `useBuilding` if its value may be (round 2, Codex F2).
    if (ts.isPropertyAssignment(declaration)) return changeable([declaration.initializer], seen, name);
    if (ts.isShorthandPropertyAssignment(declaration)) return changeable([declaration.name], seen, name);
    return { unresolved: name };
  };

  /** The name an import chain ending in a module the program can't read last exports its binding as. */
  const exportedName = (start: ts.Symbol, name: string): string => {
    let last = name;
    for (let at: ts.Symbol | undefined = start; at && at.flags & ts.SymbolFlags.Alias; ) {
      const declaration = at.declarations?.[0];
      if (declaration && (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration))) last = (declaration.propertyName ?? declaration.name).text;
      else if (declaration && ts.isImportClause(declaration)) last = 'default';
      at = checker.getImmediateAliasedSymbol(at);
    }
    return last;
  };

  return (callee: ts.Expression) => ofExpression(callee, new Set());
}

/**
 * Whether the options may make the read passive. Read in order, the last member that can set `passive` deciding, as
 * at runtime: `passive: false` doesn't, any other `passive` value does, and so does a member it can't read (a spread,
 * a computed name, an accessor), which may set it (review round 1, Codex F1). No argument, or no such member, isn't.
 * An argument that isn't an object literal is.
 */
function isPassive(options: ts.Expression | undefined): boolean {
  if (options === undefined) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  let passive = false;
  for (const property of options.properties) {
    const plain = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property);
    if (!plain || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) passive = true;
    else if (property.name.text === 'passive') passive = !ts.isPropertyAssignment(property) || property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
  }
  return passive;
}

const isHookName = (name: string) => /^use[A-Z]/.test(name);

/**
 * Each function in `files` (path under src → source) that calls a hook, with what it calls, and the keys of the two
 * hooks the rule is about, as defined in `PROVIDER`.
 */
export function analyze(files: Record<string, string>): { fns: Fn[]; denial: string | undefined; building: string | undefined } {
  const sources = new Map(Object.entries(files).map(([path, text]) => [join(SRC, path), text]));
  const built = program(sources);
  const provider = built.getSourceFile(join(SRC, PROVIDER));
  const exported = (name: string) => {
    const found = provider?.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    return found && keyOf(found);
  };
  const denial = exported('useBuildingDenied');
  const building = exported('useBuilding');
  const resolve = resolver(built.getTypeChecker(), built.getSourceFiles(), (fn) => keyOf(fn) === building);

  const fns = new Map<string, Fn>();
  for (const tree of built.getSourceFiles()) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        let callee: ts.Expression = unwrap(node.expression);
        let args: readonly ts.Expression[] = node.arguments;
        let applied = false;
        // `hook.call(thisArg, options)` and `hook.apply(thisArg, [options])` run `hook`.
        if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'call' || callee.name.text === 'apply')) {
          applied = callee.name.text === 'apply';
          callee = callee.expression;
          args = args.slice(1);
        }
        const target = resolve(callee);
        const name = 'fn' in target ? functionName(target.fn) : target.unresolved;
        const isBuilding = 'fn' in target ? keyOf(target.fn) === building : name === 'useBuilding' || name === '<computed>';
        if (isHookName(name) || isBuilding) {
          const at = owner(node);
          const key = at ? keyOf(at) : `${underSrc(tree.fileName)}::<module>`;
          const id = `${underSrc(tree.fileName)}::${at ? functionName(at) : '<module>'}`;
          const fn = fns.get(key) ?? { id, key, passive: false, calls: new Set<string>() };
          fn.calls.add('fn' in target ? keyOf(target.fn) : `<unresolved>::${name}`);
          // `apply`'s options are in an array it can't read: passive (fail-closed). A computed callee with no argument
          // reads like `useBuilding()`, the active reader the rule leaves alone.
          if (isBuilding && (applied ? args.length > 0 : isPassive(args[0]))) fn.passive = true;
          fns.set(key, fn);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return { fns: [...fns.values()], denial, building };
}

/**
 * The passive readers that read no denial. A function reads it if it calls the denial or another function that does,
 * found to a fixed point, each known by its key, so only the function a call resolves to counts.
 */
export function unguarded({ fns, denial }: { fns: Fn[]; denial: string | undefined }): string[] {
  const aware = new Set(denial ? [denial] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const fn of fns) {
      if (!aware.has(fn.key) && [...fn.calls].some((hook) => aware.has(hook))) {
        aware.add(fn.key);
        grew = true;
      }
    }
  }
  return fns.filter((fn) => fn.passive && ![...fn.calls].some((hook) => aware.has(hook))).map((fn) => fn.id);
}

/**
 * Every TypeScript source under src (not the tests), so an import through a module outside app and features resolves
 * and a passive reader anywhere counts (round 3, Codex F1). A `.js` module stays unread, named as above.
 */
const SCANNED = sourceFiles(SRC).map(underSrc);

let cached: ReturnType<typeof analyze> | undefined;
function inventory(): ReturnType<typeof analyze> {
  cached ??= analyze(Object.fromEntries(SCANNED.map((path) => [path, readFileSync(join(SRC, path), 'utf8')])));
  return cached;
}

describe('passive building readers also read the denial (P5-05 criterion 11, P3-05)', () => {
  it('every passive reader under src reads useBuildingDenied, or is exempt with a reason', () => {
    expect(unguarded(inventory()).filter((id) => !(id in EXEMPT))).toEqual([]);
  });

  it('every exemption is still a passive reader that reads no denial', () => {
    expect(Object.keys(EXEMPT).filter((id) => !unguarded(inventory()).includes(id))).toEqual([]);
  });

  it('finds the readers the rule is about (the scan is not empty)', () => {
    const passive = inventory().fns.filter((fn) => fn.passive).map((fn) => fn.id);
    expect(passive).toEqual(expect.arrayContaining(['app/AccountMenu.tsx::BuildingChoices', 'app/MainNav.tsx::BuildingNav']));
  });

  it('resolves the two hooks in the real provider, and a hook that reads the denial through it', () => {
    const { denial, building, fns } = inventory();
    expect(denial).toBeDefined();
    expect(building).toBeDefined();
    expect(existsSync(join(SRC, PROVIDER))).toBe(true);
    // `useCanViewAs` reads the denial; the nav's passive reader passes through it and its own call.
    expect(fns.find((fn) => fn.id === 'app/MainNav.tsx::useCanViewAs')?.calls).toContain(denial);
  });
});

describe('the inspector', () => {
  /** The provider the cases import: the two hooks, defined as the real ones are (function declarations). */
  const PROVIDER_STUB = 'export function useBuilding(options?: unknown) { return options; }\nexport function useBuildingDenied() { return false; }\n';
  const check = (files: Record<string, string>) => unguarded(analyze({ [PROVIDER]: PROVIDER_STUB, ...files }));
  const run = (source: string) => check({ 'features/x/X.tsx': source });
  const IMPORT = "import { useBuilding, useBuildingDenied } from '@/app/BuildingProvider';\n";

  it('lists a passive reader that reads no denial', () => {
    expect(run(`${IMPORT}function A() { const b = useBuilding({ passive: true }); return b.data; }`)).toEqual(['features/x/X.tsx::A']);
  });

  it('passes a reader that reads the denial itself, or through a hook that does, even two hooks deep', () => {
    expect(run(`${IMPORT}function A() { useBuilding({ passive: true }); const d = useBuildingDenied(); }`)).toEqual([]);
    expect(run(`${IMPORT}const useCan = () => !useBuildingDenied();\nconst useMore = () => useCan();\nconst A = () => { useBuilding({ passive: true }); useMore(); };`)).toEqual([]);
  });

  it('a hook named like the denial reader but not reading it does not count', () => {
    expect(run(`${IMPORT}function useLooksSafe() { return true; }\nfunction A() { useBuilding({ passive: true }); useLooksSafe(); }`)).toEqual([
      'features/x/X.tsx::A',
    ]);
  });

  it('resolves renamed imports of both hooks', () => {
    expect(run("import { useBuilding as ub } from '@/app/BuildingProvider';\nfunction A() { ub({ passive: true }); }")).toEqual(['features/x/X.tsx::A']);
    expect(run("import { useBuilding as ub, useBuildingDenied as denied } from '@/app/BuildingProvider';\nfunction A() { ub({ passive: true }); denied(); }")).toEqual([]);
  });

  it('is fail-closed on an argument it cannot read, and ignores the active reader', () => {
    expect(run(`${IMPORT}function A() { useBuilding(options); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${IMPORT}function A() { useBuilding({ ...options }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${IMPORT}function A() { useBuilding({ passive: flag }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${IMPORT}function A() { useBuilding(); }\nfunction B() { useBuilding({ passive: false }); }`)).toEqual([]);
  });

  // Review round 1, Codex F1: a namespace import's call and a spread after `passive: false` passed the gate.
  const NS = "import * as Building from '@/app/BuildingProvider';\n";
  it('R1-F1: lists a passive reader called through a namespace import, and passes its namespace denial read', () => {
    expect(run(`${NS}function A() { const b = Building.useBuilding({ passive: true }); return b.data; }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${NS}function A() { Building.useBuilding({ passive: true }); Building.useBuildingDenied(); }`)).toEqual([]);
  });

  it('R1-F1 neighbours: any object’s `useBuilding` counts (fail-closed); another object’s `useBuildingDenied` does not', () => {
    expect(run('function A() { hooks.useBuilding({ passive: true }); }')).toEqual(['features/x/X.tsx::A']);
    expect(run(`${IMPORT}function A() { useBuilding({ passive: true }); fake.useBuildingDenied(); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${NS}const useCan = () => !Building.useBuildingDenied();\nfunction A() { Building.useBuilding({ passive: true }); useCan(); }`)).toEqual([]);
  });

  it('R1-F1: a spread after `passive: false` may make it passive; the last of them decides, as at runtime', () => {
    expect(run(`${IMPORT}function A() { useBuilding({ passive: false, ...options }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${IMPORT}function A() { useBuilding({ ...options, passive: false }); }`)).toEqual([]);
    expect(run(`${IMPORT}function A() { useBuilding({ passive: true, passive: false }); }`)).toEqual([]);
    expect(run(`${IMPORT}function A() { useBuilding({ passive: false, passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${IMPORT}function A() { useBuilding({ enabled: true }); }`)).toEqual([]);
  });

  // Review round 1, Claude M1: wrapped and anonymous components shared one `<module>` entry, and a hook that reads the
  // denial was matched by name in any file.
  it('R1-M1: a wrapped component is its variable, so a denial read in its neighbour does not cover it', () => {
    expect(run(`${IMPORT}export const A = memo(() => { useBuilding({ passive: true }); });\nexport const B = memo(() => { useBuildingDenied(); });`)).toEqual([
      'features/x/X.tsx::A',
    ]);
    expect(run(`${IMPORT}export const A = memo(forwardRef(() => { useBuilding({ passive: true }); useBuildingDenied(); }));`)).toEqual([]);
    expect(run(`${IMPORT}export const A = forwardRef(function Inner() { useBuilding({ passive: true }); });`)).toEqual(['features/x/X.tsx::Inner']);
  });

  it('R1-M1: an anonymous component is its own entry', () => {
    expect(run(`${IMPORT}export default function () { useBuilding({ passive: true }); }\nexport const C = memo(() => { useBuildingDenied(); });`)).toEqual([
      'features/x/X.tsx::default',
    ]);
    expect(run(`${IMPORT}export default memo(() => { useBuilding({ passive: true }); });\nfunction C() { useBuildingDenied(); }`)).toEqual([
      'features/x/X.tsx::default',
    ]);
    expect(run(`${IMPORT}register(() => { useBuilding({ passive: true }); });\nfunction C() { useBuildingDenied(); }`)).toEqual([
      'features/x/X.tsx::<anonymous@2>',
    ]);
  });

  it('R1-M1: a hook that reads the denial counts only where it is defined, resolved through the import', () => {
    const SAFE = "import { useBuildingDenied } from '@/app/BuildingProvider';\nexport function useCanX() { return !useBuildingDenied(); }";
    const local = `${IMPORT}function useCanX() { return true; }\nfunction P() { useBuilding({ passive: true }); useCanX(); }`;
    expect(check({ 'features/a/A.tsx': SAFE, 'features/b/B.tsx': local })).toEqual(['features/b/B.tsx::P']);
    const imported = `${IMPORT}import { useCanX } from '@/features/a/A';\nfunction P() { useBuilding({ passive: true }); useCanX(); }`;
    expect(check({ 'features/a/A.tsx': SAFE, 'features/b/B.tsx': imported })).toEqual([]);
    const relativeImport = `${IMPORT}import { useCanX as can } from './A';\nfunction P() { useBuilding({ passive: true }); can(); }`;
    expect(check({ 'features/a/A.tsx': SAFE, 'features/a/P.tsx': relativeImport })).toEqual([]);
    const elsewhere = `${IMPORT}import { useCanX } from '@/features/c/C';\nfunction P() { useBuilding({ passive: true }); useCanX(); }`;
    expect(check({ 'features/a/A.tsx': SAFE, 'features/b/B.tsx': elsewhere })).toEqual(['features/b/B.tsx::P']);
    // The denial itself, through its module's name only.
    expect(run("import { useBuilding } from '@/app/BuildingProvider';\nimport { useBuildingDenied } from './fake';\nfunction A() { useBuilding({ passive: true }); useBuildingDenied(); }")).toEqual([
      'features/x/X.tsx::A',
    ]);
  });

  // Review round 2, Codex F1 and F2: an element-access call escaped, and a nested hook made a module-level hook of
  // the same name count as reading the denial.
  it('R2-F1: an element-access call is read like a property access; a computed one counts as `useBuilding` (fail-closed)', () => {
    expect(run(`${NS}function A() { Building['useBuilding']({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${NS}function A() { Building['useBuilding']({ passive: true }); Building['useBuildingDenied'](); }`)).toEqual([]);
    expect(run(`${NS}function A() { Building[name]({ passive: true }); Building.useBuildingDenied(); }`)).toEqual([]);
    // With no argument it reads like `useBuilding()`, the active reader the rule leaves alone.
    expect(run(`${NS}function A() { Building[name](); }`)).toEqual([]);
    expect(run('function A() { hooks[`useBuilding`]({ passive: true }); }')).toEqual(['features/x/X.tsx::A']);
  });

  it('R2-F2: a nested hook is its own, so it never makes a module-level hook of its name read the denial', () => {
    const NESTED = `${IMPORT}function useCan() { return true; }\nexport function A() { useBuilding({ passive: true }); useCan(); }\n`;
    expect(run(`${NESTED}export function G() { function useCan() { return !useBuildingDenied(); } return useCan(); }`)).toEqual([
      'features/x/X.tsx::A',
    ]);
    expect(run(`${NESTED}export function G() { const useCan = () => !useBuildingDenied(); return useCan(); }`)).toEqual(['features/x/X.tsx::A']);
    // A module-level hook still counts, however it is declared.
    expect(run(`${IMPORT}const useCan = memo(() => !useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useCan(); }`)).toEqual([]);
  });

  // Review round 2, Claude L1: a hook bound to a local name escaped.
  it('R2-L1: a hook bound to a local name, by assignment or destructuring, is that hook', () => {
    expect(run(`${IMPORT}const read = useBuilding;\nfunction A() { read({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${NS}const { useBuilding: ub } = Building;\nfunction A() { ub({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${NS}const { useBuilding } = Building;\nfunction A() { useBuilding({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${NS}const read = Building.useBuilding;\nfunction A() { read({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    // The denial through the same shapes counts, so a guarded component still passes.
    expect(run(`${NS}const { useBuilding: ub, useBuildingDenied: denied } = Building;\nfunction A() { ub({ passive: true }); denied(); }`)).toEqual([]);
    expect(run(`${IMPORT}const denied = useBuildingDenied;\nfunction A() { useBuilding({ passive: true }); denied(); }`)).toEqual([]);
    // Destructured from anything else, `useBuilding` still counts (fail-closed) and the denial doesn't.
    expect(run(`const { useBuilding: ub } = hooks;\nfunction A() { ub({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${IMPORT}const { useBuildingDenied: d } = fake;\nfunction A() { useBuilding({ passive: true }); d(); }`)).toEqual(['features/x/X.tsx::A']);
  });

  it('a denial read in another component does not cover this one', () => {
    expect(run(`${IMPORT}function A() { useBuildingDenied(); return <B />; }\nfunction B() { useBuilding({ passive: true }); }`)).toEqual([
      'features/x/X.tsx::B',
    ]);
  });

  // Review round 3, Codex F1 / Claude L1 (PR #121): names were resolved without scope, so these passed a reader that
  // reads no denial. Each now fails, and the same shapes reading the denial pass.
  it('R3: a function-local alias of the denial covers only its own function', () => {
    expect(run(`${IMPORT}function G() { const read = useBuildingDenied; read(); }\nfunction A() { useBuilding({ passive: true }); read(); }`)).toEqual([
      'features/x/X.tsx::A',
    ]);
    expect(run(`${IMPORT}function A() { const read = useBuildingDenied; useBuilding({ passive: true }); read(); }`)).toEqual([]);
  });

  it('R3: a declaration that shadows a hook reading the denial is the one called', () => {
    const SAFE = `${IMPORT}function useCheck() { return !useBuildingDenied(); }\n`;
    expect(run(`${SAFE}function A() { function useCheck() { return false; } useBuilding({ passive: true }); useCheck(); }`)).toEqual([
      'features/x/X.tsx::A',
    ]);
    expect(run(`${SAFE}function A() { const useCheck = () => false; useBuilding({ passive: true }); useCheck(); }`)).toEqual(['features/x/X.tsx::A']);
    // A local named like the denial is not the denial.
    expect(run(`${IMPORT}function A() { const useBuildingDenied = () => false; useBuilding({ passive: true }); useBuildingDenied(); }`)).toEqual([
      'features/x/X.tsx::A',
    ]);
    // Unshadowed, the module's hook still counts.
    expect(run(`${SAFE}function A() { useBuilding({ passive: true }); useCheck(); }`)).toEqual([]);
  });

  it('R3: a callee in `!`, parentheses, `as` or `.call`/`.apply` is still the hook', () => {
    for (const call of [
      'useBuilding!({ passive: true })',
      '(useBuilding)({ passive: true })',
      '(useBuilding as typeof useBuilding)({ passive: true })',
      'useBuilding.call(null, { passive: true })',
      'useBuilding.apply(null, [{ passive: false }])',
      'Building.useBuilding.call(undefined, { passive: true })',
    ]) {
      expect(run(`${IMPORT}${NS}function A() { ${call}; }`), call).toEqual(['features/x/X.tsx::A']);
    }
    expect(run(`${IMPORT}function A() { useBuilding.call(null, { passive: false }); }`)).toEqual([]);
    for (const denied of ['useBuildingDenied!()', '(useBuildingDenied)()', 'useBuildingDenied.call(null)']) {
      expect(run(`${IMPORT}function A() { useBuilding({ passive: true }); ${denied}; }`), denied).toEqual([]);
    }
  });

  // P6-02a review round 1, Codex F1 and F2: a mutable alias of `useBuilding` escaped, and a hook passed to any call was
  // taken as what the call returns. A value the checker can't follow that mentions `useBuilding` now counts as it
  // (fail-closed), and only an inline function inside a call is that call's function.
  it.each(['let', 'var'])('P6-02a R1-F1: a `%s` alias of `useBuilding` is a passive reader', (kind) => {
    expect(run(`${IMPORT}${kind} read = useBuilding;\nfunction A() { read({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
    expect(run(`${NS}${kind} read = Building.useBuilding;\nfunction A() { read({ passive: true }); }`)).toEqual(['features/x/X.tsx::A']);
  });

  it('P6-02a R1-F1 neighbours: any value that may be `useBuilding` counts as it; none earns the denial', () => {
    const FLAGGED = ['features/x/X.tsx::A'];
    // Reassigned later, or declared without a value.
    expect(run(`${IMPORT}let read = () => null;\nread = useBuilding;\nfunction A() { read({ passive: true }); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}let read;\nfunction set() { read = useBuilding; }\nfunction A() { read({ passive: true }); }`)).toEqual(FLAGGED);
    // A parameter's default, a conditional and a logical choice.
    expect(run(`${IMPORT}function A(read = useBuilding) { read({ passive: true }); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const read = flag ? useBuilding : () => null;\nfunction A() { read({ passive: true }); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const read = other || useBuilding;\nfunction A() { read({ passive: true }); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}function A() { (flag ? useBuilding : other)({ passive: true }); }`)).toEqual(FLAGGED);
    // Through a `const` alias of an alias.
    expect(run(`${IMPORT}const b = useBuilding;\nlet read = b;\nfunction A() { read({ passive: true }); }`)).toEqual(FLAGGED);
    // The same shapes never read the denial for the reader.
    expect(run(`${IMPORT}let denied = useBuildingDenied;\nfunction A() { useBuilding({ passive: true }); denied(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const denied = flag ? useBuildingDenied : () => false;\nfunction A() { useBuilding({ passive: true }); denied(); }`)).toEqual(FLAGGED);
    // A `let` alias that is never `useBuilding` stays out of the rule.
    expect(run(`${IMPORT}let read = () => null;\nfunction A() { read({ passive: true }); }`)).toEqual([]);
  });

  it('P6-02a R1-F2: a hook passed to a factory is not what the factory returns', () => {
    const FLAGGED = ['features/x/X.tsx::A'];
    const FACTORY = 'function makeHook(_ignored: unknown) { return () => false; }\n';
    expect(run(`${IMPORT}${FACTORY}const useNoDenial = makeHook(useBuildingDenied);\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const useNoDenial = memo(useBuildingDenied);\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    // A factory given `useBuilding` may return it: counts as it (fail-closed).
    expect(run(`${IMPORT}${FACTORY}const useB = makeHook(useBuilding);\nfunction A() { useB({ passive: true }); }`)).toEqual(FLAGGED);
    // An inline function in a wrapper is still the wrapper's, however deep.
    expect(run(`${IMPORT}const useCan = memo(forwardRef(() => !useBuildingDenied()));\nfunction A() { useBuilding({ passive: true }); useCan(); }`)).toEqual([]);
  });

  // P6-02a review round 2, Codex F1 and F2: a named callback given to any call, and an object's member, earned the
  // denial though neither need be what runs. Only bindings that can't change earn it: imports and namespace members,
  // `const` aliases, function declarations never reassigned, and an inline function in React's `memo` or `forwardRef`.
  it('P6-02a R2-F1: an inline function given to a call other than `memo` or `forwardRef` earns nothing', () => {
    const FLAGGED = ['features/x/X.tsx::A'];
    const FACTORY = 'function makeHook(_ignored: unknown) { return () => false; }\n';
    expect(
      run(`${IMPORT}${FACTORY}const useNoDenial = makeHook(function useDiscarded() { return useBuildingDenied(); });\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`),
    ).toEqual(FLAGGED);
    expect(run(`${IMPORT}${FACTORY}const useNoDenial = makeHook(() => useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    // A local function called `memo` is not React's.
    expect(run(`${IMPORT}function memo(_f: unknown) { return () => false; }\nconst useCan = memo(() => !useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useCan(); }`)).toEqual(FLAGGED);
    // React's wrappers, imported or not, keep their function.
    const REACT = "import { memo, forwardRef } from 'react';\n";
    expect(run(`${IMPORT}${REACT}const useCan = memo(forwardRef(() => !useBuildingDenied()));\nfunction A() { useBuilding({ passive: true }); useCan(); }`)).toEqual([]);
  });

  it('P6-02a R2-F2: an object’s member, a method and a reassigned function earn no denial', () => {
    const FLAGGED = ['features/x/X.tsx::A'];
    expect(run(`${IMPORT}const hooks = { useBuildingDenied };\nhooks.useBuildingDenied = () => false;\nfunction A() { useBuilding({ passive: true }); hooks.useBuildingDenied(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const hooks = { denied: useBuildingDenied };\nfunction A() { useBuilding({ passive: true }); hooks.denied(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const hooks = { useCan() { return useBuildingDenied(); } };\nfunction A() { useBuilding({ passive: true }); hooks.useCan(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}class Hooks { static useCan() { return useBuildingDenied(); } }\nfunction A() { useBuilding({ passive: true }); Hooks.useCan(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const hooks = { useBuildingDenied };\nconst { useBuildingDenied: d } = hooks;\nfunction A() { useBuilding({ passive: true }); d(); }`)).toEqual(FLAGGED);
    // A function declaration is a mutable binding: once reassigned, it earns nothing.
    const SAFE = `${IMPORT}function useCheck() { return !useBuildingDenied(); }\n`;
    expect(run(`${SAFE}function off() { useCheck = () => false; }\nfunction A() { useBuilding({ passive: true }); useCheck(); }`)).toEqual(FLAGGED);
    expect(run(`${SAFE}useCheck ??= () => false;\nfunction A() { useBuilding({ passive: true }); useCheck(); }`)).toEqual(FLAGGED);
    expect(run(`${SAFE}function A() { useBuilding({ passive: true }); useCheck(); }`)).toEqual([]);
    // Fail-closed the other way: an object's member that may be `useBuilding` is a passive reader.
    expect(run(`${IMPORT}const hooks = { read: useBuilding };\nfunction A() { hooks.read({ passive: true }); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}function useB(o: unknown) { return o; }\nuseB = useBuilding;\nfunction A() { useB({ passive: true }); }`)).toEqual(FLAGGED);
  });

  it('R3 neighbours: a `let` alias may be reassigned, so it is no denial; a re-export is followed', () => {
    expect(run(`${IMPORT}let read = useBuildingDenied;\nread = () => false;\nfunction A() { useBuilding({ passive: true }); read(); }`)).toEqual([
      'features/x/X.tsx::A',
    ]);
    const REEXPORT = "export { useBuildingDenied as useDenied, useBuilding as useB } from '@/app/BuildingProvider';\n";
    expect(check({ 'features/r/index.ts': REEXPORT, 'features/x/X.tsx': "import { useB, useDenied } from '@/features/r';\nfunction A() { useB({ passive: true }); useDenied(); }" })).toEqual([]);
    expect(check({ 'features/r/index.ts': REEXPORT, 'features/x/X.tsx': "import { useB } from '@/features/r';\nfunction A() { useB({ passive: true }); }" })).toEqual([
      'features/x/X.tsx::A',
    ]);
  });

  // P6-02a review round 3, Codex F1: an import the program can't follow (a module outside the scan, a `.js` barrel)
  // kept only its local name, so a renamed `useBuilding` escaped. It keeps the name it is exported by, as the P5-05
  // inspector did, and the scan reads all of src.
  it('P6-02a R3-F1: a renamed import from a module the program cannot read keeps its exported name', () => {
    const FLAGGED = ['features/x/X.tsx::A'];
    expect(run("import { useBuilding as read } from '@/lib/building';\nfunction A() { return read({ passive: true }); }")).toEqual(FLAGGED);
    expect(run("import { useBuilding as read } from './building.js';\nfunction A() { read({ passive: true }); }")).toEqual(FLAGGED);
    // Through an alias of it, and through a barrel in the scan that re-exports from outside it.
    expect(run("import { useBuilding as read } from '@/lib/building';\nlet r = read;\nfunction A() { r({ passive: true }); }")).toEqual(FLAGGED);
    const OUT = { 'features/r/index.ts': "export { useBuilding as useB } from '@/lib/building';\n" };
    expect(check({ ...OUT, 'features/x/X.tsx': "import { useB as read } from '@/features/r';\nfunction A() { read({ passive: true }); }" })).toEqual(FLAGGED);
    const STAR = { 'features/r/index.ts': "export * from '@/lib/building';\n" };
    expect(check({ ...STAR, 'features/x/X.tsx': "import { useBuilding as read } from '@/features/r';\nfunction A() { read({ passive: true }); }" })).toEqual(FLAGGED);
    // The denial from a module it can't read earns nothing, renamed or not.
    expect(run(`${IMPORT}import { useBuildingDenied as d } from '@/lib/building';\nfunction A() { useBuilding({ passive: true }); d(); }`)).toEqual(FLAGGED);
    // A barrel under src/lib that the program reads is followed, renames included.
    const LIB = { 'lib/building.ts': "export { useBuilding as useThing, useBuildingDenied as useSafe } from '@/app/BuildingProvider';\n" };
    expect(check({ ...LIB, 'features/x/X.tsx': "import { useThing } from '@/lib/building';\nfunction A() { useThing({ passive: true }); }" })).toEqual(FLAGGED);
    expect(check({ ...LIB, 'features/x/X.tsx': "import { useThing, useSafe } from '@/lib/building';\nfunction A() { useThing({ passive: true }); useSafe(); }" })).toEqual([]);
    // And a passive reader outside app/features is the rule's too.
    expect(check({ 'lib/X.tsx': `${IMPORT}function A() { useBuilding({ passive: true }); }` })).toEqual(['lib/X.tsx::A']);
  });

  it('P6-02a R3-F1: the inventory reads every source file under src, not only app and features', () => {
    expect(SCANNED).toEqual(expect.arrayContaining(['api/client.ts', 'utils/index.ts', 'test/renderApp.tsx']));
    expect(SCANNED.filter((path) => /\.test\.tsx?$/.test(path))).toEqual([]);
  });

  // P6-02a review round 3, Codex F2: `memo`'s comparison callback was taken as the function it wraps, and React's
  // mutable default export was trusted though `React.memo` can be replaced. Only the first argument is the wrapped
  // function, and only a named or namespace import of React (or the global) is trusted, while nothing can have
  // replaced it.
  it('P6-02a R3-F2: only the first argument of `memo` or `forwardRef` is the function it wraps', () => {
    const FLAGGED = ['features/x/X.tsx::A'];
    const REACT = "import { memo, forwardRef } from 'react';\n";
    const NO_DENIAL = 'function NoDenial() { return null; }\n';
    expect(run(`${REACT}${IMPORT}${NO_DENIAL}const useNoDenial = memo(NoDenial, function useCompare() { return useBuildingDenied(); });\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    expect(run(`${REACT}${IMPORT}${NO_DENIAL}const useNoDenial = memo(NoDenial, () => useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}${NO_DENIAL}const useNoDenial = memo(NoDenial, () => useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    expect(run(`${REACT}${IMPORT}${NO_DENIAL}const useNoDenial = memo(forwardRef(NoDenial), () => useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    expect(run(`${REACT}${IMPORT}${NO_DENIAL}const useNoDenial = forwardRef(NoDenial, () => useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    // Another of React's exports imported under the wrapper's name is not the wrapper.
    expect(run(`import { useMemo as memo } from 'react';\n${IMPORT}const useCan = memo(() => !useBuildingDenied());\nfunction A() { useBuilding({ passive: true }); useCan(); }`)).toEqual(FLAGGED);
    // A named function expression is known by its own name, as the P5-05 inspector knew it: given to a wrapper or
    // bound to a `const`, it earns the variable nothing (found by the round-3 fix's differential run).
    expect(run(`${REACT}${IMPORT}const useNoDenial = memo(function useInner() { return useBuildingDenied(); });\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    expect(run(`${REACT}${IMPORT}const useNoDenial = memo(forwardRef(function useInner() { return useBuildingDenied(); }));\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    expect(run(`${IMPORT}const useNoDenial = function useInner() { return useBuildingDenied(); };\nfunction A() { useBuilding({ passive: true }); useNoDenial(); }`)).toEqual(FLAGGED);
    // The first argument still is, by name or namespace, however deep.
    expect(run(`import { memo as m } from 'react';\n${IMPORT}const useCan = m(() => !useBuildingDenied(), () => true);\nfunction A() { useBuilding({ passive: true }); useCan(); }`)).toEqual([]);
    expect(run(`import * as React from 'react';\n${IMPORT}const useCan = React.memo(React.forwardRef(() => !useBuildingDenied()));\nfunction A() { useBuilding({ passive: true }); useCan(); }`)).toEqual([]);
  });

  it('P6-02a R3-F2: React’s wrappers are trusted only while nothing in the program can have replaced them', () => {
    const FLAGGED = ['features/x/X.tsx::A'];
    const FACTORY = 'function makeHook(_ignored: unknown) { return () => false; }\n';
    const USE = 'function A() { useBuilding({ passive: true }); useNoDenial(); }';
    // React's default export is a mutable object: never trusted, replaced or not.
    expect(run(`import React from 'react';\n${IMPORT}${FACTORY}React.memo = makeHook;\nconst useNoDenial = React.memo(function useDiscarded() { return useBuildingDenied(); });\n${USE}`)).toEqual(FLAGGED);
    expect(run(`import React from 'react';\n${IMPORT}const useNoDenial = React.memo(function useDiscarded() { return useBuildingDenied(); });\n${USE}`)).toEqual(FLAGGED);
    expect(run(`import React from 'react';\n${IMPORT}const useNoDenial = React.memo(() => useBuildingDenied());\n${USE}`)).toEqual(FLAGGED);
    // Its named export reads that same object under the bundler's interop: a write there, in any file, ends the trust.
    const SAFE = `import { memo } from 'react';\n${IMPORT}const useNoDenial = memo(() => useBuildingDenied());\n${USE}`;
    expect(run(SAFE)).toEqual([]);
    for (const patch of [
      `import React from 'react';\n${FACTORY}React.memo = makeHook;`,
      `import React from 'react';\n${FACTORY}React['memo'] = makeHook;`,
      `import React from 'react';\n${FACTORY}const key = 'memo';\nReact[key] = makeHook;`,
      `import React from 'react';\n${FACTORY}Object.assign(React, { memo: makeHook });`,
      `import React from 'react';\nconst R = React;\nR.memo = () => () => false;`,
      `import * as React from 'react';\n${FACTORY}React.memo = makeHook;`,
      `import React from 'react';\ndelete React.memo;`,
      `${FACTORY}({ memo: globalThis.memo } = { memo: makeHook });`,
      `${FACTORY}globalThis.memo = makeHook;`,
      `${FACTORY}window['forwardRef'] = makeHook;`,
      `${FACTORY}const g = globalThis;\nconst key = 'memo';\ng[key] = makeHook;`,
    ]) {
      expect(check({ 'lib/patch.ts': patch, 'features/x/X.tsx': SAFE }), patch).toEqual(FLAGGED);
    }
    // Reading React or the global object by name leaves it trusted, and so does a member or a name that only shares
    // the global's (`variables.self`, as features/residents/api.ts has).
    const READS =
      "import React from 'react';\nexport const f = React.Fragment;\nexport const w = typeof window === 'undefined' ? null : window.location.href;\n" +
      'export function g<T extends { self: boolean }>(variables: T, o: { window: number }) { const { self } = variables; return [variables.self, self, o.window, { global: 1 }]; }\n' +
      'export const h = (variables: unknown, k: string) => [(variables as never).self, (variables as never)[k]];\n';
    expect(check({ 'lib/reads.ts': READS, 'features/x/X.tsx': SAFE })).toEqual([]);
  });
});
