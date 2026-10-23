/**
 * P5-05 criterion 11, the P3-05 fitness test: a component that reads the building passively
 * (`useBuilding({ passive: true })`) shows what the guards loaded, and a refetch that fails keeps the old `data`. Once
 * the building is denied (a 401 or 404 on any of its requests, app/buildingDenial.ts), that data must not be shown,
 * so the same function must also read `useBuildingDenied()`, itself or through a hook that does (`useCanViewAs`), or
 * be exempt below with the reason.
 *
 * Read with the TypeScript parser, not text matching (CLAUDE.md lessons): a renamed or namespace import is still the
 * hook, an argument it can't read counts as passive (fail-closed), and the hooks that read the denial are found from
 * their bodies, so a new one counts without a list here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const ROOTS = ['app', 'features'];
/** The denial hook, as `<module>::<name>`: a module is its path under src without the extension (`app/guards`). */
const DENIAL = 'app/BuildingProvider::useBuildingDenied';

/** `<path under src>::<function>` → why it may read the building passively without reading the denial. */
const EXEMPT: Record<string, string> = {
  'app/BuildingProvider.tsx::useBuildingDenied': 'It is the denial: it reads the building to compare the denial with its last answer.',
  'features/packages/WaitingList.tsx::WaitingList':
    'Rendered only by SecurityPackagesPage, a route under RequireActiveMembership → BuildingLoaded, which renders the ' +
    'denial screen instead of its children once useBuildingDenied() is true (app/guards.tsx).',
  'features/packages/pages/MyPackagesPage.tsx::Packages':
    'Rendered only by MyPackagesPage, a route under RequireActiveMembership → BuildingLoaded, which renders the denial ' +
    'screen instead of its children once useBuildingDenied() is true (app/guards.tsx).',
};

interface Fn {
  id: string;
  name: string;
  /** Its module, as in `DENIAL`. */
  module: string;
  /** It calls `useBuilding` with `passive: true`, or with an argument it can't read. */
  passive: boolean;
  /** The hooks it calls, as `<module>::<exported name>`, each resolved through the file's imports. */
  calls: Set<string>;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A source file's module: its path under src, without the extension or a trailing `/index`. */
function moduleOf(file: string): string {
  return relative(SRC, file).split(sep).join('/').replace(/\.tsx?$/, '').replace(/\/index$/, '');
}

/** The module an import names, from `from`'s module: `@/…` and relative paths; a package keeps its own name. */
function resolveModule(from: string, specifier: string): string {
  if (specifier.startsWith('@/')) return specifier.slice(2).replace(/\.tsx?$/, '').replace(/\/index$/, '');
  if (specifier.startsWith('.')) return posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.tsx?$/, '').replace(/\/index$/, '');
  return `package:${specifier}`;
}

/**
 * Each named import's local name → `<module>::<exported name>` (`useBuilding as ub` → `app/BuildingProvider::useBuilding`),
 * and each namespace import's local name → its module (`* as Building`; review round 1, Codex F1). Resolved to the
 * module, so a hook is known by where it is defined, not by its name alone (review round 1, Claude M1).
 */
function imports(tree: ts.SourceFile, module: string): { names: Map<string, string>; namespaces: Map<string, string> } {
  const names = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = resolveModule(module, statement.moduleSpecifier.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, from);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.set(element.name.text, `${from}::${(element.propertyName ?? element.name).text}`);
    }
  }
  return { names, namespaces };
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

/** The function a hook call runs in: the nearest one around it, since hooks run in a component's or hook's own body. */
function owner(node: ts.Node): FunctionNode | undefined {
  for (let at = node.parent; at; at = at.parent) if (isFunction(at)) return at;
  return undefined;
}

/**
 * Whether the options may make the read passive. Read in order, the last member that can set `passive` deciding, as
 * at runtime: `passive: false` doesn't, any other `passive` value does, and so does a member it can't read (a spread,
 * a computed name, an accessor), which may set it (review round 1, Codex F1). No argument, or no such member, isn't.
 * An argument that isn't an object literal is.
 */
function isPassive(call: ts.CallExpression): boolean {
  const [options] = call.arguments;
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

/** Each function in `source` that calls a hook, with what it calls. */
export function inspect(file: string, source: string): Fn[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const module = moduleOf(file);
  const { names, namespaces } = imports(tree, module);
  // The hook a call names, as `<module>::<name>`: an identifier (imported, else this module's own), a namespace
  // import's member, or any other object's `useBuilding` (fail-closed: it can only add a passive reader). Another
  // object's other members are no hook, so `fake.useBuildingDenied()` reads no denial.
  const hookOf = (callee: ts.Expression): { key: string; name: string } | undefined => {
    if (ts.isIdentifier(callee)) {
      const key = names.get(callee.text) ?? `${module}::${callee.text}`;
      return { key, name: key.slice(key.lastIndexOf('::') + 2) };
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const member = callee.name.text;
    const from = ts.isIdentifier(callee.expression) ? namespaces.get(callee.expression.text) : undefined;
    if (from !== undefined) return { key: `${from}::${member}`, name: member };
    return member === 'useBuilding' ? { key: `<member>::${member}`, name: member } : undefined;
  };
  const fns = new Map<ts.Node | undefined, Fn>();
  const visit = (node: ts.Node) => {
    const hook = ts.isCallExpression(node) ? hookOf(node.expression) : undefined;
    if (ts.isCallExpression(node) && hook !== undefined && /^use[A-Z]/.test(hook.name)) {
      const at = owner(node);
      const name = at ? functionName(at) : '<module>';
      const fn = fns.get(at) ?? { id: `${relative(SRC, file).split(sep).join('/')}::${name}`, name, module, passive: false, calls: new Set<string>() };
      fn.calls.add(hook.key);
      if (hook.name === 'useBuilding' && isPassive(node)) fn.passive = true;
      fns.set(at, fn);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...fns.values()];
}

/**
 * The passive readers that read no denial, given every function. A hook reads it if it calls the denial or another
 * hook that does, found to a fixed point, each known by its module and name.
 */
export function unguarded(fns: Fn[]): string[] {
  const aware = new Set([DENIAL]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const fn of fns) {
      const key = `${fn.module}::${fn.name}`;
      if (/^use[A-Z]/.test(fn.name) && !aware.has(key) && [...fn.calls].some((hook) => aware.has(hook))) {
        aware.add(key);
        grew = true;
      }
    }
  }
  return fns.filter((fn) => fn.passive && ![...fn.calls].some((hook) => aware.has(hook))).map((fn) => fn.id);
}

function inventory(): Fn[] {
  return ROOTS.flatMap((root) => sourceFiles(join(SRC, root))).flatMap((file) => inspect(file, readFileSync(file, 'utf8')));
}

describe('passive building readers also read the denial (P5-05 criterion 11, P3-05)', () => {
  it('every passive reader under src/app and src/features reads useBuildingDenied, or is exempt with a reason', () => {
    expect(unguarded(inventory()).filter((id) => !(id in EXEMPT))).toEqual([]);
  });

  it('every exemption is still a passive reader that reads no denial', () => {
    expect(Object.keys(EXEMPT).filter((id) => !unguarded(inventory()).includes(id))).toEqual([]);
  });

  it('finds the readers the rule is about (the scan is not empty)', () => {
    const passive = inventory().filter((fn) => fn.passive).map((fn) => fn.id);
    expect(passive).toEqual(expect.arrayContaining(['app/AccountMenu.tsx::BuildingChoices', 'app/MainNav.tsx::BuildingNav']));
  });
});

describe('the inspector', () => {
  const run = (source: string) => unguarded(inspect(join(SRC, 'features/x/X.tsx'), source));
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
    const a = inspect(join(SRC, 'features/a/A.tsx'), SAFE);
    const local = inspect(join(SRC, 'features/b/B.tsx'), `${IMPORT}function useCanX() { return true; }\nfunction P() { useBuilding({ passive: true }); useCanX(); }`);
    expect(unguarded([...a, ...local])).toEqual(['features/b/B.tsx::P']);
    const imported = inspect(join(SRC, 'features/b/B.tsx'), `${IMPORT}import { useCanX } from '@/features/a/A';\nfunction P() { useBuilding({ passive: true }); useCanX(); }`);
    expect(unguarded([...a, ...imported])).toEqual([]);
    const relative = inspect(join(SRC, 'features/a/P.tsx'), `${IMPORT}import { useCanX as can } from './A';\nfunction P() { useBuilding({ passive: true }); can(); }`);
    expect(unguarded([...a, ...relative])).toEqual([]);
    const elsewhere = inspect(join(SRC, 'features/b/B.tsx'), `${IMPORT}import { useCanX } from '@/features/c/C';\nfunction P() { useBuilding({ passive: true }); useCanX(); }`);
    expect(unguarded([...a, ...elsewhere])).toEqual(['features/b/B.tsx::P']);
    // The denial itself, through its module's name only.
    expect(run("import { useBuilding } from '@/app/BuildingProvider';\nimport { useBuildingDenied } from './fake';\nfunction A() { useBuilding({ passive: true }); useBuildingDenied(); }")).toEqual([
      'features/x/X.tsx::A',
    ]);
  });

  it('a denial read in another component does not cover this one', () => {
    expect(run(`${IMPORT}function A() { useBuildingDenied(); return <B />; }\nfunction B() { useBuilding({ passive: true }); }`)).toEqual([
      'features/x/X.tsx::B',
    ]);
  });
});
