import { NavLink } from 'react-router-dom';

import { ApiError } from '@/api/errors';
import { useBuilding, useBuildingContext } from '@/app/BuildingProvider';
import { navPages, PAGE_ACCESS } from '@/app/pages';
import type { components } from '@/api/schema';
import type { ViewAs } from '@/app/buildingStorage';

type Building = components['schemas']['BuildingOut'];

/**
 * True if the member may use council "view as" in the selected building: both `/me` and the building's
 * answer say they hold `council` there. Either source dropping it is enough, so a `/me` refetch that removes
 * the role takes the toggle away before the building is asked again (review round 1, F1).
 */
export function useCanViewAs(building: Building | undefined): boolean {
  const { buildingId, active } = useBuildingContext();
  const membership = active.find((m) => m.building.id === buildingId);
  return !!building && building.my_roles.includes('council') && !!membership?.roles.includes('council');
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
  const building = useBuilding();
  const { viewAs } = useBuildingContext();
  const canViewAs = useCanViewAs(building.data);
  // Like BuildingLoaded: a 401 or 404 on a refetch means the cached building must not be shown any more.
  const status = building.error instanceof ApiError ? building.error.status : null;
  if (!building.data || status === 401 || status === 404) return null;

  return (
    <nav aria-label="Main" className="border-b bg-white px-4">
      <ul className="mx-auto flex max-w-5xl flex-wrap gap-x-4 gap-y-1 py-2 text-sm">
        {navPages(building.data, effectiveView(canViewAs, viewAs)).map((page) => (
          <li key={page}>
            <NavLink
              to={`/${page}`}
              className={({ isActive }) =>
                isActive ? 'font-semibold text-slate-900 underline' : 'text-slate-700 hover:underline'
              }
            >
              {PAGE_ACCESS[page].label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
