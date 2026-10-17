/**
 * True for every path the router sends to the login page: any case, percent-encoded letters
 * (`/%6cogin`), trailing slashes. A path that can't be decoded counts too, so it is never followed.
 */
export function isLoginPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.toLowerCase().replace(/\/+$/, '') === '/login';
}

/**
 * Where to go after logging in. `next` comes from the URL, so anyone can write a link with it: following
 * `//evil.example` or `/\evil.example` (browsers read both as another host) would be an open redirect.
 * Only a path on this origin is followed, and never back to the login page; anything else goes home.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  // Browsers treat "\" as "/" and drop tabs and newlines in URLs, so "/\evil" and "/\t/evil" are hosts too.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  const url = new URL(next, 'http://app.invalid');
  if (url.origin !== 'http://app.invalid' || isLoginPath(url.pathname)) return '/';
  return next;
}

/** The login page's URL that returns to `location` afterwards. */
export function loginPath(location: { pathname: string; search: string }): string {
  if ((location.pathname === '/' && !location.search) || isLoginPath(location.pathname)) return '/login';
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}
