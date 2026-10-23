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
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const ROOTS = ['app', 'features'];
const DENIAL = 'useBuildingDenied';

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
  /** It calls `useBuilding` with `passive: true`, or with an argument it can't read. */
  passive: boolean;
  /** The hook names it calls, imports resolved to their exported names. */
  calls: Set<string>;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * Each named import's local name → its exported name (`useBuilding as ub` → `useBuilding`), and the namespace
 * imports (`* as Building`), whose members are the module's own names (review round 1, Codex F1).
 */
function importNames(tree: ts.SourceFile): { names: Map<string, string>; namespaces: Set<string> } {
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of tree.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return { names, namespaces };
}

/** A function's name: its declaration's, or the variable an arrow or function expression is assigned to. */
function functionName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
  return undefined;
}

/** The named function a call is in: hooks run in the component or hook body, not in a callback inside it. */
function owner(node: ts.Node): string {
  for (let at = node.parent; at; at = at.parent) {
    const name = functionName(at);
    if (name !== undefined) return name;
  }
  return '<module>';
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

/** Each named function in `source` that calls a hook, with what it calls. */
export function inspect(file: string, source: string): Fn[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const { names, namespaces } = importNames(tree);
  // The hook a call names: an identifier (a renamed import resolved), a namespace import's member, or any object's
  // `useBuilding` (fail-closed: it can only add a passive reader). Another object's member is no hook, so a
  // `fake.useBuildingDenied()` reads no denial.
  const hookOf = (callee: ts.Expression): string | undefined => {
    if (ts.isIdentifier(callee)) return names.get(callee.text) ?? callee.text;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const member = callee.name.text;
    if (ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)) return member;
    return member === 'useBuilding' ? member : undefined;
  };
  const fns = new Map<string, Fn>();
  const visit = (node: ts.Node) => {
    const hook = ts.isCallExpression(node) ? hookOf(node.expression) : undefined;
    if (ts.isCallExpression(node) && hook !== undefined) {
      if (/^use[A-Z]/.test(hook)) {
        const name = owner(node);
        const id = `${relative(SRC, file)}::${name}`;
        const fn = fns.get(id) ?? { id, name, passive: false, calls: new Set<string>() };
        fn.calls.add(hook);
        if (hook === 'useBuilding' && isPassive(node)) fn.passive = true;
        fns.set(id, fn);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...fns.values()];
}

/** The passive readers that read no denial, given every function: the hooks that read it are found to a fixed point. */
export function unguarded(fns: Fn[]): string[] {
  const aware = new Set([DENIAL]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const fn of fns) {
      if (/^use[A-Z]/.test(fn.name) && !aware.has(fn.name) && [...fn.calls].some((hook) => aware.has(hook))) {
        aware.add(fn.name);
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

  it('a denial read in another component does not cover this one', () => {
    expect(run(`${IMPORT}function A() { useBuildingDenied(); return <B />; }\nfunction B() { useBuilding({ passive: true }); }`)).toEqual([
      'features/x/X.tsx::B',
    ]);
  });
});
