/**
 * Pages exposed in the demo: the "Demo" tier of the page → scope map in docs/PRODUCT_SCOPE.md.
 * Every other Base44 page stays in the repo but is not routed and not shown in navigation (ADR-0011).
 * Names are `pages.config.js` keys, plus `Contacts`, which App.jsx registers itself.
 */
export const DEMO_PAGES = [
  'Home',
  'Dashboard',
  'Onboarding',
  'ResidentSetup',
  'Residents',
  'Packages',
  'SecurityPackages',
  'ManagementNotices',
  'Maintenance',
  'ManagementMaintenance',
  'Profile',
  'Contacts',
] as const;

const demoPages = new Set<string>(DEMO_PAGES.map((name) => name.toLowerCase()));

/** True if a page name is in the demo scope. Case-insensitive, like React Router's matching. */
export function isDemoPage(name: string): boolean {
  return demoPages.has(name.toLowerCase());
}

/** True if an app path such as `/packages?tab=1` points at a demo page. */
export function isDemoPath(path: string): boolean {
  const name = path.replace(/^\//, '').split(/[/?#]/)[0];
  return isDemoPage(name);
}
