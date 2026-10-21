/**
 * Pages exposed in the demo: the "Demo" tier of the page → scope map in docs/PRODUCT_SCOPE.md.
 * Every other Base44 page stays in the repo but is not routed and not shown in navigation (ADR-0011).
 * Names are the Base44 page names (files in src/pages), as their routes were.
 */
export const DEMO_PAGES = [
  'Home',
  'Dashboard',
  'Packages',
  'SecurityPackages',
  'ManagementNotices',
  'Maintenance',
  'ManagementMaintenance',
  'Profile',
  'Contacts',
] as const;

export type DemoPage = (typeof DEMO_PAGES)[number];

const demoPages = new Set<string>(DEMO_PAGES.map((name) => name.toLowerCase()));

/** True if a page name is in the demo scope. Case-insensitive, like React Router's matching. */
export function isDemoPage(name: string): boolean {
  return demoPages.has(name.toLowerCase());
}

/**
 * Dashboard view modes that render a whole page inline. A view is in scope only if its page is:
 * the "financials" view renders the Financials page, which is not in the demo.
 */
const VIEW_ROLE_PAGES: ReadonlyMap<string, string> = new Map([['financials', 'Financials']]);

/**
 * True if a dashboard view role (resident, security, property_management, board, financials…) is shown.
 * Roles come from `?role=` and localStorage, so the lookup is a Map: an object literal would also
 * return inherited members such as `constructor`.
 */
export function isDemoViewRole(role: string): boolean {
  const page = VIEW_ROLE_PAGES.get(role);
  return page === undefined || isDemoPage(page);
}

/** True if an app path such as `/packages?tab=1` points at a demo page. */
export function isDemoPath(path: string): boolean {
  const name = path.replace(/^\//, '').split(/[/?#]/)[0];
  return isDemoPage(name);
}
