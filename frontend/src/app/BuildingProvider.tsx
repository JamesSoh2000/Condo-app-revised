import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/api/client';
import type { components } from '@/api/schema';
import { useMe } from '@/app/AuthProvider';
import { readSelectedBuilding, writeSelectedBuilding } from '@/app/buildingStorage';

type Membership = components['schemas']['MeMembershipOut'];

interface BuildingContextValue {
  /** The building this tab works in, or null while none is chosen (picker) or none is active. */
  buildingId: string | null;
  /** The user's active memberships, from `/me`: the only buildings that can be selected. */
  active: Membership[];
  /** Selects `id` if it is an active membership; a switch drops the old building's queries. */
  select: (id: string) => void;
  /** Forgets the selection and every building's queries (the picker or the default comes next). */
  reset: () => void;
}

const BuildingContext = createContext<BuildingContextValue | null>(null);

/**
 * The tab's building (ADR-0011, docs/ARCHITECTURE.md §13). Rendered inside `RequireAuth`, so `/me` is loaded.
 * The stored ID is used only while it is one of `/me`'s active memberships, checked on every render: a
 * foreign, stale or edited value never reaches a URL.
 */
export function BuildingProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  // Remounted for another user (another tab logged in on the shared cookie): nothing of the previous
  // user's selection survives in this tab's state (AuthProvider drops their cached data).
  return <UserBuildingProvider key={me?.user.id}>{children}</UserBuildingProvider>;
}

function UserBuildingProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [stored, setStored] = useState(readSelectedBuilding);

  const active = useMemo(() => (me?.memberships ?? []).filter((m) => m.status === 'active'), [me]);
  const buildingId = active.some((m) => m.building.id === stored)
    ? stored
    : active.length === 1
      ? active[0].building.id
      : null;

  // Keep the tab's storage equal to the effective selection: the default once chosen, nothing once invalid.
  useEffect(() => {
    // Re-run on `stored` too: after reset() the default can be the same building as before.
    if (readSelectedBuilding() !== buildingId) writeSelectedBuilding(buildingId);
  }, [buildingId, stored]);

  const select = useCallback(
    (id: string) => {
      if (id === buildingId || !active.some((m) => m.building.id === id)) return;
      if (buildingId !== null) {
        // Removing a query also aborts its request (it is cancelled with its `signal`), so a late answer
        // from the old building can't land anywhere; every building key starts ['b', id].
        queryClient.removeQueries({ queryKey: ['b', buildingId] });
        // The current page may be closed in the new building (role, feature).
        navigate('/');
      }
      writeSelectedBuilding(id);
      setStored(id);
    },
    [active, buildingId, navigate, queryClient],
  );

  const reset = useCallback(() => {
    queryClient.removeQueries({ queryKey: ['b'] });
    // The effect above then stores whatever is selected next (the default, or nothing: the picker).
    setStored(null);
  }, [queryClient]);

  const value = useMemo(() => ({ buildingId, active, select, reset }), [buildingId, active, select, reset]);
  return <BuildingContext.Provider value={value}>{children}</BuildingContext.Provider>;
}

export function useBuildingContext(): BuildingContextValue {
  const context = useContext(BuildingContext);
  if (!context) throw new Error('useBuildingContext needs a BuildingProvider');
  return context;
}

/** The selected building's ID. Only under `RequireActiveMembership`, which renders nothing without one. */
export function useBuildingId(): string {
  const { buildingId } = useBuildingContext();
  if (buildingId === null) throw new Error('useBuildingId needs a selected building (RequireActiveMembership)');
  return buildingId;
}

/** The selected building as its member sees it: the caller's roles there and its features. */
export function useBuilding() {
  const buildingId = useBuildingId();
  return useQuery({
    queryKey: ['b', buildingId, 'building'],
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}', { params: { path: { building_id: buildingId } }, signal }),
  });
}
