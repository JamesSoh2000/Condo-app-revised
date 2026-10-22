/**
 * P4-08f criterion 9, a fitness test for the "cached answer reused on remount" pattern (PR #98 R3 M1, P4-08d R1 F2,
 * P4-08e R1 F2): a building query whose component unmounts and comes back while its data changes elsewhere is
 * served from the 30 s `staleTime` (app/queryClient.ts) unless it opts out. Every `useQuery`/`useInfiniteQuery` call
 * under `src/app` and `src/features` is read from source. A building query passes only with
 * `refetchOnMount: 'always'`, `gcTime: 0` or `staleTime: 0` in its options, or with an exemption below giving the
 * reason. Fail-closed: a call whose options or key it can't read counts as a building query without any.
 *
 * Read with the TypeScript parser, not text matching: a generic call (`useQuery<Row[]>(…)`) is still a call, and only
 * the options object's own top-level properties count, not one inside `queryFn`'s result or a comment (review
 * round 1, Codex gpt-6.1-sol F1).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const ROOTS = ['app', 'features'];

/** `<path under src>::<enclosing function>` → why its cached answer may be reused on remount. */
const EXEMPT: Record<string, string> = {
  'app/BuildingProvider.tsx::useBuilding':
    'Every building guard mounts it, so asking on each mount would ask on every navigation. Roles and features it ' +
    'gates are enforced by the API; a /me refetch removing council takes "view as" away at once (useCanViewAs), and ' +
    'a denial from any building request closes the building (buildingDenial.ts).',
  'features/files/PrivateImage.tsx::PrivateImageFor':
    'Its staleTime follows the presigned URL’s expiry, and an image that fails asks again: the answer is a URL ' +
    'that stays valid, not data another screen changes.',
};

const QUERY_HOOK = /^use(?:Suspense)?(?:Infinite)?Quer(?:y|ies)$/;

/** A top-level option whose value means "don't serve a cached answer on mount", with the literal text it needs. */
const FRESH: Record<string, string> = { refetchOnMount: "'always'", gcTime: '0', staleTime: '0' };

interface Call {
  id: string;
  /** A building query: its key is not an array literal starting with a string other than 'b'. */
  building: boolean;
  /** Its options object declares one of `FRESH` at its own top level. */
  fresh: boolean;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The name of the function the call is in: a declaration's, or the variable an arrow or function expression is in. */
function owner(node: ts.Node): string {
  for (let at = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText();
    if (ts.isVariableDeclaration(at) && at.initializer && (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))) {
      return at.name.getText();
    }
  }
  return '<module>';
}

/** The options object's own properties by name; null when they can't all be read (a spread, a computed name). */
function topLevel(options: ts.ObjectLiteralExpression): Map<string, ts.Expression> | null {
  const properties = new Map<string, ts.Expression>();
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      properties.set(property.name.text, property.initializer);
    } else if (!ts.isShorthandPropertyAssignment(property) && !ts.isMethodDeclaration(property)) {
      return null;
    }
  }
  return properties;
}

function classify(options: ts.Expression | undefined): Omit<Call, 'id'> {
  const properties = options && ts.isObjectLiteralExpression(options) ? topLevel(options) : null;
  if (properties === null) return { building: true, fresh: false };
  const key = properties.get('queryKey');
  const first = key && ts.isArrayLiteralExpression(key) ? key.elements[0] : undefined;
  const building = !(first && ts.isStringLiteral(first) && first.text !== 'b');
  const fresh = Object.entries(FRESH).some(([name, value]) => properties.get(name)?.getText() === value);
  return { building, fresh };
}

/** Each query hook call in `source`, by `<path under src>::<enclosing function>`. */
export function inspect(file: string, source: string): Call[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const calls: Call[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && QUERY_HOOK.test(node.expression.text)) {
      const options = node.expression.text === 'useQueries' ? undefined : node.arguments[0];
      calls.push({ id: `${relative(SRC, file)}::${owner(node)}`, ...classify(options) });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return calls;
}

function inventory(): Call[] {
  return ROOTS.flatMap((root) => sourceFiles(join(SRC, root))).flatMap((file) => inspect(file, readFileSync(file, 'utf8')));
}

describe('building queries declare how they stay fresh on remount (P4-08f criterion 9)', () => {
  const calls = inventory();
  const building = calls.filter((call) => call.building);

  it('finds the known queries, so it can’t pass by finding none', () => {
    const ids = calls.map((call) => call.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'features/notifications/api.ts::useNotificationSummary',
        'features/notifications/api.ts::useNotifications',
        'features/residents/api.ts::usePendingRequests',
        'app/AuthProvider.tsx::useMe',
      ]),
    );
    expect(building.map((call) => call.id)).not.toContain('app/AuthProvider.tsx::useMe');
  });

  it('every building query refetches on mount, keeps nothing, or is exempt with a reason', () => {
    const offenders = building.filter((call) => !call.fresh && !(call.id in EXEMPT)).map((call) => call.id);
    expect(offenders).toEqual([]);
  });

  it('every exemption still names a building query that needs it', () => {
    const needed = new Set(building.filter((call) => !call.fresh).map((call) => call.id));
    expect(Object.keys(EXEMPT).filter((id) => !needed.has(id))).toEqual([]);
  });

  it('reads the rules as intended (fail-closed on what it can’t read)', () => {
    const read = (source: string) => inspect(join(SRC, 'features/x/api.ts'), source);
    expect(read("function useA() { return useQuery({ queryKey: ['b', id, 'a'], queryFn }); }")).toEqual([
      { id: 'features/x/api.ts::useA', building: true, fresh: false },
    ]);
    expect(read("function useB() { return useInfiniteQuery({ queryKey: key(id), staleTime: 0 }); }")).toEqual([
      { id: 'features/x/api.ts::useB', building: true, fresh: true },
    ]);
    expect(read('function useC() { return useQuery(options); }')).toEqual([
      { id: 'features/x/api.ts::useC', building: true, fresh: false },
    ]);
    expect(read("function useD() { return useQuery({ queryKey: ['me'], queryFn }); }")).toEqual([
      { id: 'features/x/api.ts::useD', building: false, fresh: false },
    ]);
    expect(read('function useE() { return useQuery({ queryKey: k, staleTime: 0_000 }); }')[0].fresh).toBe(false);
    expect(read('function useF() { return useQuery({ queryKey: k, staleTime: 30_000 }); }')[0].fresh).toBe(false);
  });

  // Review round 1 (Codex gpt-6.1-sol) F1: generic calls were not listed, and a freshness option anywhere in the
  // options' text counted, even inside `queryFn`'s returned object.
  const one = (source: string) => inspect(join(SRC, 'features/x/api.ts'), source);
  it.each(['useQuery<Row[]>', 'useInfiniteQuery<Page, Error>', 'useQuery<Map<string, Row>>'])(
    'R1-F1: lists a generic call (%s) as a building query without freshness',
    (hook) => {
      expect(one(`function useRows() { return ${hook}({ queryKey: ['b', id, 'rows'], queryFn }); }`)).toEqual([
        { id: 'features/x/api.ts::useRows', building: true, fresh: false },
      ]);
    },
  );

  it.each([
    ['inside queryFn’s returned object', "queryFn: async () => ({ staleTime: 0, rows: [] }), staleTime: 30_000"],
    ['inside a nested object', "meta: { gcTime: 0 }, queryFn"],
    ['in a comment', "// staleTime: 0 would be wrong here\n queryFn"],
    ['spread from elsewhere', "...freshOptions, queryFn"],
  ])('R1-F1: a freshness option only counts at the options’ top level (not %s)', (_label, rest) => {
    expect(one(`function useRows() { return useQuery({ queryKey: ['b', id, 'rows'], ${rest} }); }`)).toEqual([
      { id: 'features/x/api.ts::useRows', building: true, fresh: false },
    ]);
  });

  // Review round 2 (Codex gpt-6.1-sol) F1: a member that isn't a plain property was skipped, so one written after
  // `staleTime: 0` that replaces it at runtime (a computed method) still read as fresh.
  it.each([
    ['a computed method', "staleTime: 0, [optionName]() { return 30_000; }"],
    ['a method of that name', "staleTime: 0, staleTime() { return 30_000; }"],
    ['a getter of that name', "staleTime: 0, get staleTime() { return 30_000; }"],
    ['a shorthand of that name', "staleTime: 0, staleTime"],
    ['a computed property', "staleTime: 0, ['stale' + 'Time']: 30_000"],
  ])('R2-F1: a later member that can replace the option makes it not fresh (%s)', (_label, rest) => {
    expect(one(`function useRows() { return useQuery({ queryKey: ['b', id, 'rows'], ${rest} }); }`)).toEqual([
      { id: 'features/x/api.ts::useRows', building: true, fresh: false },
    ]);
  });

  it('R2-F1 neighbours: other plain methods and shorthands leave a fresh option fresh; a later literal wins', () => {
    expect(one("function useA() { return useQuery({ queryKey: ['b'], queryFn() { return x; }, select, staleTime: 0 }); }")[0].fresh).toBe(true);
    expect(one("function useB() { return useQuery({ queryKey: ['b'], staleTime: 30_000, staleTime: 0 }); }")[0].fresh).toBe(true);
    expect(one("function useC() { return useQuery({ queryKey: ['b'], staleTime: 0, staleTime: 30_000 }); }")[0].fresh).toBe(false);
    expect(one("function useD() { return useQuery({ queryKey: ['me'], get queryKey() { return ['b']; } }); }")[0].building).toBe(true);
  });

  it('R1-F1 neighbours: top-level options count, and a key read only from the top level', () => {
    expect(one("function useA() { return useQuery({ queryFn: () => ({ queryKey: ['me'] }), queryKey: key(id), refetchOnMount: 'always' }); }")).toEqual([
      { id: 'features/x/api.ts::useA', building: true, fresh: true },
    ]);
    expect(one("const useB = () => useInfiniteQuery({ queryKey: ['b', id], gcTime: 0 });")).toEqual([
      { id: 'features/x/api.ts::useB', building: true, fresh: true },
    ]);
    expect(one("function useC() { return useQuery({ queryKey: ['me'], queryFn }); }")).toEqual([
      { id: 'features/x/api.ts::useC', building: false, fresh: false },
    ]);
    expect(one("function useD() { return useQuery({ staleTime: 0x0, queryKey: ['b'] }); }")).toEqual([
      { id: 'features/x/api.ts::useD', building: true, fresh: false },
    ]);
  });
});
