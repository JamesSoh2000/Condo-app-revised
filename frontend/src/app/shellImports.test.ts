/**
 * P2-06a criterion 9: the shell reaches no Base44 code. The ESLint fence only sees the direct imports of
 * files under src/app and src/features; this walks the whole import graph from the shell's entry points,
 * through legacy files too, so a shell file importing a legacy page that imports Base44 also fails.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const BASE44_PACKAGE = /^@base44\//;
const BASE44_LEGACY_MODULE = /\/api\/(base44Client|entities|integrations)(\.[cm]?[jt]sx?)?$/;
const BASE44_TEXT = /base44\.|@base44\//;

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(SRC, specifier.slice(2)) : path.resolve(path.dirname(from), specifier);
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every local source file reachable from `entries`, and every package specifier they import. */
export function importGraph(entries: string[]): { files: Set<string>; packages: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        if (/\.(css|svg|png|jpe?g|json)$/.test(specifier)) continue;
        const target = resolveLocal(file, specifier);
        if (target) queue.push(target);
        else unresolved.push(`${path.relative(SRC, file)} -> ${specifier}`);
      } else {
        packages.add(specifier);
      }
    }
  }
  return { files, packages, unresolved };
}

const ENTRIES = [path.join(SRC, 'main.jsx'), path.join(SRC, 'app/App.tsx')];

describe('the shell import graph (P2-06a criterion 9)', () => {
  const graph = importGraph(ENTRIES);
  const relative = [...graph.files].map((file) => path.relative(SRC, file)).sort();

  it('starts from main.jsx, which renders the new shell', () => {
    expect(relative).toContain('app/App.tsx');
    expect(relative).not.toContain('App.jsx');
    expect(graph.unresolved).toEqual([]);
  });

  it('imports no Base44 package', () => {
    expect([...graph.packages].filter((specifier) => BASE44_PACKAGE.test(specifier))).toEqual([]);
  });

  it('reaches no legacy Base44 client module, layout or page', () => {
    const forbidden = relative.filter(
      (file) =>
        BASE44_LEGACY_MODULE.test(`/${file}`) ||
        file.startsWith('pages/') ||
        ['Layout.jsx', 'pages.config.js', 'lib/AuthContext.jsx', 'lib/LanguageContext.jsx'].includes(file),
    );
    expect(forbidden).toEqual([]);
  });

  it('contains no Base44 reference in any reached file', () => {
    const offenders = [...graph.files].filter((file) => BASE44_TEXT.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
