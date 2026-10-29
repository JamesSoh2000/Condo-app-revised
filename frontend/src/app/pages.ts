import type { components } from '@/api/schema';
import type { ViewAs } from '@/app/buildingStorage';
import type { DemoPage } from '@/app/routeScope';

type Role = components['schemas']['Role'];
type Feature = components['schemas']['Feature'];
type Building = components['schemas']['BuildingOut'];

/** Who may open a page. The routes guard on it (P2-06b) and the navigation is built from it (P2-06c). */
export interface PageAccess {
  /** The roles that may open it in the selected building; absent means any active member. */
  roles?: readonly Role[];
  /** A feature the selected building must have enabled. */
  feature?: Feature;
  /** The navigation's label; a page without one is not in the navigation (P2-06c). */
  label?: string;
  /** A migrated page's own path; a legacy one keeps `/<Name>`. */
  path?: string;
}

/** The demo's legacy pages and the migrated ones that took a legacy page's place (P4-08b). */
export type Page = DemoPage | 'Residents' | 'Notices';

const STAFF: readonly Role[] = ['security', 'property_management', 'council'];

/**
 * One row per demo page, in navigation order. The roles follow the ticket that owns the page where it says
 * (P5-03, P5-04) and docs/PRODUCT_SCOPE.md otherwise; each slice may change its own row. The routes guard
 * on it and the navigation lists from it, so the two can't disagree. UX only: the API checks again.
 */
export const PAGE_ACCESS: Record<Page, PageAccess> = {
  Home: {},
  Dashboard: { label: 'Dashboard' },
  Profile: { label: 'My profile' },
  Contacts: { label: 'Contacts' },
  Residents: { roles: ['property_management'], label: 'Residents', path: '/manage/residents' },
  Packages: { roles: ['resident'], feature: 'packages', label: 'My packages', path: '/packages' },
  SecurityPackages: {
    roles: ['security', 'property_management'],
    feature: 'packages',
    label: 'Package log',
    path: '/security/packages',
  },
  // Every member reads the building's notices (P6-02a); `visible_notices` decides which.
  Notices: { feature: 'notices', label: 'Notices', path: '/notices' },
  // Only property management publishes and archives (P6-01b); the others read the feed (P6-02c D1).
  ManagementNotices: { roles: ['property_management'], feature: 'notices', label: 'Manage notices', path: '/manage/notices' },
  Maintenance: { roles: ['resident'], feature: 'maintenance', label: 'Maintenance requests', path: '/maintenance' },
  ManagementMaintenance: { roles: STAFF, feature: 'maintenance', label: 'Maintenance' },
};

/** Where a page is: its own path, or the legacy `/<Name>`. */
export const pagePath = (page: Page): string => PAGE_ACCESS[page].path ?? `/${page}`;

/** True if the caller's roles in `building` include one of `roles` (any role when absent). */
export function hasRole(building: Building, roles: readonly Role[] | undefined): boolean {
  return !roles || roles.some((role) => building.my_roles.includes(role));
}

/** True if `building` has `feature` enabled (always when absent). */
export function hasFeature(building: Building, feature: Feature | undefined): boolean {
  return !feature || building.features.includes(feature);
}

/**
 * The pages the navigation lists in `building`: those with a label that the caller's roles and the
 * building's features allow, in `PAGE_ACCESS` order. A council member's `view` then keeps the pages open to
 * any member plus those for a resident (`resident`) or for a staff role (`management`): it only ever hides
 * items, never adds one the roles don't allow.
 */
export function navPages(building: Building, view: ViewAs | null): Page[] {
  return (Object.keys(PAGE_ACCESS) as Page[]).filter((page) => {
    const { label, roles, feature } = PAGE_ACCESS[page];
    if (!label || !hasRole(building, roles) || !hasFeature(building, feature)) return false;
    if (view === null || !roles) return true;
    return view === 'resident' ? roles.includes('resident') : roles.some((role) => role !== 'resident');
  });
}
