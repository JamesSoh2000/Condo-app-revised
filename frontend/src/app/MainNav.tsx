import { NavLink } from 'react-router-dom';

import { ApiError } from '@/api/errors';
import { useBuilding, useBuildingContext } from '@/app/BuildingProvider';
import { navPages, PAGE_ACCESS } from '@/app/pages';
import type { components } from '@/api/schema';
import type { ViewAs } from '@/app/buildingStorage';

type Building = components['schemas']['BuildingOut'];

/** True if the member may use council "view as" in `building`: they hold `council` there. */
export function canViewAs(building: Building): boolean {
  return building.my_roles.includes('council');
}

/** The view the navigation applies: the tab's choice for a council member, none for anyone else. */
export function effectiveView(building: Building, viewAs: ViewAs): ViewAs | null {
  return canViewAs(building) ? viewAs : null;
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
  // Like BuildingLoaded: a 401 or 404 on a refetch means the cached building must not be shown any more.
  const status = building.error instanceof ApiError ? building.error.status : null;
  if (!building.data || status === 401 || status === 404) return null;

  return (
    <nav aria-label="Main" className="border-b bg-white px-4">
      <ul className="mx-auto flex max-w-5xl flex-wrap gap-x-4 gap-y-1 py-2 text-sm">
        {navPages(building.data, effectiveView(building.data, viewAs)).map((page) => (
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
