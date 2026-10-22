/**
 * P4-08f criterion 9, a fitness test for the "cached answer reused on remount" pattern (PR #98 R3 M1, P4-08d R1 F2,
 * P4-08e R1 F2): a building query whose component unmounts and comes back while its data changes elsewhere is
 * served from the 30 s `staleTime` (app/queryClient.ts) unless it opts out. Every `useQuery`/`useInfiniteQuery` call
 * under `src/app` and `src/features` is read from source. A building query passes only with
 * `refetchOnMount: 'always'`, `gcTime: 0` or `staleTime: 0` in its options, or with an exemption below giving the
 * reason. Fail-closed: a call whose options or key it can't read counts as a building query without any.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

const FRESH = [/\brefetchOnMount:\s*'always'/, /\bgcTime:\s*0\b/, /\bstaleTime:\s*0\b/];

interface Call {
  id: string;
  /** The options object's source, or null when the call isn't given an object literal. */
  options: string | null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The text from the `{` at `start` to its matching `}` (strings and comments are not special-cased). */
function balanced(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('unbalanced options object');
}

export function queryCalls(file: string, text: string): Call[] {
  const calls: Call[] = [];
  for (const match of text.matchAll(/\buse(?:Suspense)?(?:Infinite)?Quer(?:y|ies)\(\s*/g)) {
    const before = text.slice(0, match.index);
    const owner = [...before.matchAll(/function\s+(\w+)/g)].pop()?.[1] ?? '<module>';
    const at = match.index + match[0].length;
    const isObject = text[at] === '{' && !match[0].startsWith('useQueries');
    calls.push({ id: `${relative(SRC, file)}::${owner}`, options: isObject ? balanced(text, at) : null });
  }
  return calls;
}

/** Not a building query only when its key is an array literal starting with a string other than 'b'. */
function isBuildingQuery(options: string | null): boolean {
  const first = options?.match(/\bqueryKey:\s*\[\s*'([^']*)'/)?.[1];
  return first === undefined || first === 'b';
}

const isFresh = (options: string | null) => options !== null && FRESH.some((rule) => rule.test(options));

/** Each query call in `source`, with whether it reads as a building query and declares a freshness option. */
export function inspect(file: string, source: string): { id: string; building: boolean; fresh: boolean }[] {
  return queryCalls(file, source).map((call) => ({ id: call.id, building: isBuildingQuery(call.options), fresh: isFresh(call.options) }));
}

function inventory(): Call[] {
  return ROOTS.flatMap((root) => sourceFiles(join(SRC, root))).flatMap((file) => queryCalls(file, readFileSync(file, 'utf8')));
}

describe('building queries declare how they stay fresh on remount (P4-08f criterion 9)', () => {
  const calls = inventory();
  const building = calls.filter((call) => isBuildingQuery(call.options));

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
    const offenders = building.filter((call) => !isFresh(call.options) && !(call.id in EXEMPT)).map((call) => call.id);
    expect(offenders).toEqual([]);
  });

  it('every exemption still names a building query that needs it', () => {
    const needed = new Set(building.filter((call) => !isFresh(call.options)).map((call) => call.id));
    expect(Object.keys(EXEMPT).filter((id) => !needed.has(id))).toEqual([]);
  });

  it('reads the rules as intended (fail-closed on what it can’t read)', () => {
    const read = (source: string) => queryCalls(join(SRC, 'features/x/api.ts'), source);
    const [plain] = read("function useA() { return useQuery({ queryKey: ['b', id, 'a'], queryFn }); }");
    expect(plain).toEqual({ id: 'features/x/api.ts::useA', options: "{ queryKey: ['b', id, 'a'], queryFn }" });
    expect(isBuildingQuery(plain.options) && !isFresh(plain.options)).toBe(true);
    const [fresh] = read("function useB() { return useInfiniteQuery({ queryKey: key(id), staleTime: 0 }); }");
    expect(isBuildingQuery(fresh.options) && isFresh(fresh.options)).toBe(true);
    const [byVariable] = read('function useC() { return useQuery(options); }');
    expect(byVariable.options).toBeNull();
    expect(isBuildingQuery(byVariable.options) && !isFresh(byVariable.options)).toBe(true);
    const [other] = read("function useD() { return useQuery({ queryKey: ['me'], queryFn }); }");
    expect(isBuildingQuery(other.options)).toBe(false);
    expect(isFresh('{ staleTime: 0_000 }')).toBe(false);
    expect(isFresh('{ staleTime: 30_000 }')).toBe(false);
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
