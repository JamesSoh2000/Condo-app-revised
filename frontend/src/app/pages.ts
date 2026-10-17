import type { components } from '@/api/schema';
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
  /** For users without an active membership (onboarding): only signed in, no building. */
  onboarding?: true;
}

const STAFF: readonly Role[] = ['security', 'property_management', 'council'];

/**
 * One row per demo page. The roles follow the ticket that owns the page where it says (P5-03, P5-04) and
 * docs/PRODUCT_SCOPE.md otherwise; each slice may change its own row. UX only: the API checks again.
 */
export const PAGE_ACCESS: Record<DemoPage, PageAccess> = {
  Home: {},
  Dashboard: {},
  Profile: {},
  Contacts: {},
  Onboarding: { onboarding: true },
  ResidentSetup: { onboarding: true },
  Residents: { roles: ['property_management'] },
  Packages: { roles: ['resident'], feature: 'packages' },
  SecurityPackages: { roles: ['security', 'property_management'], feature: 'packages' },
  ManagementNotices: { roles: STAFF, feature: 'notices' },
  Maintenance: { roles: ['resident'], feature: 'maintenance' },
  ManagementMaintenance: { roles: STAFF, feature: 'maintenance' },
};

/** True if the caller's roles in `building` include one of `roles` (any role when absent). */
export function hasRole(building: Building, roles: readonly Role[] | undefined): boolean {
  return !roles || roles.some((role) => building.my_roles.includes(role));
}

/** True if `building` has `feature` enabled (always when absent). */
export function hasFeature(building: Building, feature: Feature | undefined): boolean {
  return !feature || building.features.includes(feature);
}
