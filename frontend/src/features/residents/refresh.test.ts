/**
 * P4-08i criterion 1, a fitness test for the "list refresh defeated by another fetch" pattern (P4-08b R1–R3, P4-08d
 * R1, PR #110 R1 F1): an invalidation alone reuses a first load still out, which read the list before the mutation.
 * `api.ts::refresh` cancels first; this test keeps every residents mutation on it. Read with the TypeScript parser,
 * not text matching (CLAUDE.md lesson): a call through an alias, a destructured method or `client['…']` is still a
 * use of the method.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HELPER = 'refresh';
/** The query client's methods that start or stop a fetch of existing queries: only the helper calls them. */
const METHODS = new Set(['invalidateQueries', 'cancelQueries', 'refetchQueries', 'resetQueries']);

/** What is wrong with `source`: each use of a method outside the helper, and each mutation not refreshing through it. */
export function problems(source: string): string[] {
  const tree = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const inHelper = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name?.text === HELPER) return true;
    }
    return false;
  };
  const callsHelper = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === HELPER) || (ts.forEachChild(node, callsHelper) ?? false);

  const visit = (node: ts.Node) => {
    // An identifier (`client.invalidateQueries`, `{ cancelQueries: c } = client`) or a string (`client['…']`).
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
    if (name && METHODS.has(name) && !inHelper(node)) found.push(`line ${line(node)}: ${name} outside ${HELPER}`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useMutation') {
      const [options] = node.arguments;
      const settled =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name.getText(tree) === 'onSettled')
          : undefined;
      if (!settled || !callsHelper(settled)) found.push(`line ${line(node)}: a mutation whose onSettled doesn't call ${HELPER}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

describe('residents mutations refresh through one helper (P4-08i criterion 1)', () => {
  it('api.ts uses the query client’s refresh methods only in `refresh`, and every mutation calls it', () => {
    const source = readFileSync(join(__dirname, 'api.ts'), 'utf8');
    expect(problems(source)).toEqual([]);
    // Not vacuous: the file has the helper and mutations.
    expect(source).toMatch(/function refresh\(/);
    expect(source.match(/useMutation\(/g)?.length).toBeGreaterThanOrEqual(5);
  });

  // Proof the check can fail, on each form it reads.
  it.each([
    ['a bare invalidation', `const m = () => useMutation({ onSettled: () => { void client.invalidateQueries({ queryKey: k }); } });`],
    ['a destructured method', `function f() { const { cancelQueries: c } = client; return c(); }`],
    ['an element access', `function f() { return client['refetchQueries'](); }`],
    ['a mutation without onSettled', `const m = () => useMutation({ mutationFn: send });`],
    ['an onSettled that does not call the helper', `const m = () => useMutation({ onSettled() { other(); } });`],
    ['an invalidation in a function merely named like it', `const refresh = () => client.invalidateQueries({ queryKey: k });`],
  ])('finds %s', (_label, source) => {
    expect(problems(source)).not.toEqual([]);
  });

  it('accepts the helper itself and a mutation whose onSettled calls it', () => {
    const source = `
      function refresh(client, filters) { void client.cancelQueries(filters).then(() => client.invalidateQueries(filters)); }
      const m = () => useMutation({ onSettled: (_d, _e, v) => { refresh(client, { queryKey: k }); if (v) refresh(client, { queryKey: me }); } });
    `;
    expect(problems(source)).toEqual([]);
  });
});
