import { NavLink } from 'react-router-dom';

import { useBuilding, useBuildingContext, useBuildingDenied } from '@/app/BuildingProvider';
import { navPages, PAGE_ACCESS, pagePath } from '@/app/pages';
import type { components } from '@/api/schema';
import type { ViewAs } from '@/app/buildingStorage';
import { ResidentsNavLabel } from '@/features/residents/PendingBadge';

type Building = components['schemas']['BuildingOut'];

/**
 * True if the member may use council "view as" in the selected building: both `/me` and the building's
 * answer say they hold `council` there. Either source dropping it is enough, so a `/me` refetch that removes
 * the role takes the toggle away before the building is asked again (review round 1, F1). Never while the building
 * is denied: its cached roles no longer count, as the nav it switches is hidden then (P4-08f criterion 3).
 */
export function useCanViewAs(building: Building | undefined): boolean {
  const { buildingId, active } = useBuildingContext();
  const denied = useBuildingDenied();
  const membership = active.find((m) => m.building.id === buildingId);
  return !denied && !!building && building.my_roles.includes('council') && !!membership?.roles.includes('council');
}

/** The view the navigation applies: the tab's choice for a council member, none for anyone else. */
function effectiveView(canViewAs: boolean, viewAs: ViewAs): ViewAs | null {
  return canViewAs ? viewAs : null;
}

/**
 * The main navigation (P2-06c): the selected building's pages from `PAGE_ACCESS`, filtered by the roles and
 * features of `GET /api/buildings/{id}`, the same answer the route guards use. Nothing without a selected
 * building.
 */
export function MainNav() {
  const { buildingId } = useBuildingContext();
  return buildingId === null ? null : <BuildingNav />;
}

function BuildingNav() {
  // Passive: on a page without a building guard (/403, onboarding) nothing loads the building, and the nav
  // must not be the one to (review round 2). It shows once the guards' answer is cached.
  const building = useBuilding({ passive: true });
  const { viewAs } = useBuildingContext();
  const canViewAs = useCanViewAs(building.data);
  // Like BuildingLoaded: nothing of a denied building is shown (inbox B-5).
  const denied = useBuildingDenied();
  if (!building.data || denied) return null;

  return (
    <nav aria-label="Main" className="border-b bg-white px-4">
      <ul className="mx-auto flex max-w-5xl flex-wrap gap-x-4 gap-y-1 py-2 text-sm">
        {navPages(building.data, effectiveView(canViewAs, viewAs)).map((page) => (
          <li key={page}>
            <NavLink
              to={pagePath(page)}
              className={({ isActive }) =>
                isActive ? 'font-semibold text-slate-900 underline' : 'text-slate-700 hover:underline'
              }
            >
              {page === 'Residents' ? <ResidentsNavLabel label={PAGE_ACCESS[page].label!} /> : PAGE_ACCESS[page].label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
