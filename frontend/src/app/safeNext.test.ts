import { describe, expect, it } from 'vitest';

import { loginPath, safeNext } from './safeNext';

describe('safeNext (P2-06a criterion 8)', () => {
  it.each(['/', '/Packages', '/Packages?tab=2', '/Packages?tab=2#top', '/%2F%2Fevil.example', '/login-help'])(
    'keeps the same-origin path %j',
    (next) => {
      expect(safeNext(next)).toBe(next);
    },
  );

  it.each([
    null,
    undefined,
    '',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '/\\/evil.example',
    '\\\\evil.example',
    'https://evil.example',
    'http:/evil.example',
    'javascript:alert(1)',
    'evil.example',
    'Packages',
    '/\tevil',
    '/\n/evil.example',
    '/\u0000',
    '/login',
    '/LOGIN',
    '/login?next=/x',
    '/login#x',
    // Review round 1 (Codex M2, Claude L1): the router matches these to the login page too.
    '/login/',
    '/LOGIN///',
    '/login/.',
    '/%6cogin',
    '/log%69n',
    '/%6C%6F%67%69%6E/',
    '/%E0%A4%A',
  ])('falls back to / for %j', (next) => {
    expect(safeNext(next)).toBe('/');
  });
});

describe('loginPath', () => {
  it('carries the path and query as an encoded next', () => {
    expect(loginPath({ pathname: '/Packages', search: '?tab=2' })).toBe('/login?next=%2FPackages%3Ftab%3D2');
  });

  it('has no next for the bare home page or the login page', () => {
    expect(loginPath({ pathname: '/', search: '' })).toBe('/login');
    expect(loginPath({ pathname: '/login', search: '?next=%2Fx' })).toBe('/login');
    expect(loginPath({ pathname: '/login/', search: '' })).toBe('/login');
    expect(loginPath({ pathname: '/%6cogin', search: '' })).toBe('/login');
  });

  it('keeps the home page query (review round 1, Codex L3)', () => {
    expect(loginPath({ pathname: '/', search: '?tab=2' })).toBe('/login?next=%2F%3Ftab%3D2');
  });
});
