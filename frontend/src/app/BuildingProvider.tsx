import { useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { useMe } from '@/app/AuthProvider';
import { readSelectedBuilding, readViewAs, writeSelectedBuilding, writeViewAs, type ViewAs } from '@/app/buildingStorage';

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
  /** Changes at each reset(), so what depends on the building renders again. */
  epoch: number;
  /** Council "view as", stored per tab; only the navigation reads it, and only for a council member. */
  viewAs: ViewAs;
  setViewAs: (view: ViewAs) => void;
}

const BuildingContext = createContext<BuildingContextValue | null>(null);

/**
 * The tab's building (ADR-0011, docs/ARCHITECTURE.md §13). Rendered inside `RequireAuth`, so `/me` is loaded.
 * The stored ID is used only while it is one of `/me`'s active memberships, checked on every render: a
 * foreign, stale or edited value never reaches a URL.
 */
export function BuildingProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const userId = me?.user.id;
  const queryClient = useQueryClient();

  // AuthProvider drops the previous user's cached data as soon as `/me` answers, while their tree is still
  // mounted: a query of theirs that mounts in that window (the bell's summary, P3-05) subscribes after the sweep
  // and comes back. Once the remount below has committed, their components are gone and the new user's are
  // subscribed, so a building query nobody observes can only be the previous user's: drop those.
  const previousUser = useRef(userId);
  useEffect(() => {
    if (previousUser.current !== undefined && previousUser.current !== userId) {
      queryClient.removeQueries({
        queryKey: ['b'],
        predicate: (query) => query.getObserversCount() === 0,
      });
    }
    previousUser.current = userId;
  }, [userId, queryClient]);

  useEffect(() => watchBuildingDenials(queryClient), [queryClient]);

  // Remounted for another user (another tab logged in on the shared cookie): nothing of the previous
  // user's selection survives in this tab's state (AuthProvider drops their cached data).
  return <UserBuildingProvider key={userId}>{children}</UserBuildingProvider>;
}

/**
 * When the tab lost access to a building, as a timestamp (inbox B-5). A query entry, not component state, so it
 * outlives the shell (the catch-all route unmounts it) and goes with the building's other queries on a switch,
 * `reset()`, another user or a 401.
 */
const deniedKey = (buildingId: string) => ['b', buildingId, 'denied'] as const;

/**
 * Marks a building denied when any of its requests says so: `building_not_found` (the tenancy 404, ADR-0004) from
 * a query or a mutation keyed `['b', id, …]`, or any 404 from the building itself. Another 404 code
 * (`notification_not_found`) is about one record, not the building. Returns the unsubscribe.
 */
function watchBuildingDenials(queryClient: QueryClient): () => void {
  const check = (key: QueryKey | undefined, error: unknown) => {
    if (key?.[0] !== 'b' || typeof key[1] !== 'string') return;
    if (!(error instanceof ApiError) || error.status !== 404) return;
    if (error.code === 'building_not_found' || key[2] === 'building') {
      // Built with no garbage collection: nothing observes this entry, and a default 5-minute gcTime would end
      // the denial on its own.
      queryClient.getQueryCache().build(queryClient, { queryKey: deniedKey(key[1]), gcTime: Infinity }).setData(Date.now());
    }
  };
  const queries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      // Typed `any` by the cache (`Query<any, …>`); every key in this app is an array.
      const key = event.query.queryKey as QueryKey;
      check(key, event.action.error);
    }
  });
  const mutations = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      const key: QueryKey | undefined = event.mutation.options.mutationKey;
      check(key, event.action.error);
    }
  });
  return () => {
    queries();
    mutations();
  };
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

  // The effective selection becomes the tab's choice, in state and storage: a default is kept when /me later
  // adds a building, and an invalid choice is forgotten, so it can't come back on its own (P2-06c; review
  // round 3 of P2-06b). The tab then holds what a reload would give.
  useEffect(() => {
    // Re-run on `stored` too: after reset() the default can be the same building as before.
    if (stored !== buildingId) setStored(buildingId);
    if (readSelectedBuilding() !== buildingId) writeSelectedBuilding(buildingId);
  }, [buildingId, stored]);

  // Whatever moves the selection off a building (a switch, or a /me refresh that ends its membership)
  // drops that building's queries. Removing a query also aborts its request (it is cancelled with its
  // `signal`), so a late answer from the old building can't land anywhere; every building key starts
  // ['b', id] (review round 2: a /me-driven change used to skip this).
  const previous = useRef(buildingId);
  useEffect(() => {
    const old = previous.current;
    previous.current = buildingId;
    if (old !== null && old !== buildingId) queryClient.removeQueries({ queryKey: ['b', old] });
  }, [buildingId, queryClient]);

  // `/me` saying the roles in the selected building changed means the building's answer (the guards' and the
  // nav's roles) is out of date: ask again (review round 1, F1).
  const roles = active.find((m) => m.building.id === buildingId)?.roles.join(',');
  const seen = useRef({ buildingId, roles });
  useEffect(() => {
    const last = seen.current;
    seen.current = { buildingId, roles };
    if (buildingId !== null && last.buildingId === buildingId && last.roles !== roles) {
      void queryClient.invalidateQueries({ queryKey: ['b', buildingId, 'building'] });
    }
  }, [buildingId, roles, queryClient]);

  const select = useCallback(
    (id: string) => {
      if (id === buildingId || !active.some((m) => m.building.id === id)) return;
      // The current page may be closed in the new building (role, feature).
      if (buildingId !== null) navigate('/');
      writeSelectedBuilding(id);
      setStored(id);
    },
    [active, buildingId, navigate],
  );

  // Bumped by reset(), so the guards render again and ask for the building again even when the selection
  // comes out the same (review round 2: with one active membership the click changed no state).
  const [epoch, setEpoch] = useState(0);
  const reset = useCallback(() => {
    queryClient.removeQueries({ queryKey: ['b'] });
    // The effect above then stores whatever is selected next (the default, or nothing: the picker).
    setStored(null);
    setEpoch((n) => n + 1);
  }, [queryClient]);

  const [viewAs, setView] = useState(readViewAs);
  const setViewAs = useCallback((view: ViewAs) => {
    writeViewAs(view);
    setView(view);
  }, []);

  const value = useMemo(
    () => ({ buildingId, active, select, reset, epoch, viewAs, setViewAs }),
    [buildingId, active, select, reset, epoch, viewAs, setViewAs],
  );
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

/**
 * The selected building as its member sees it: the caller's roles there and its features. A component that
 * only shows what the guards loaded passes `passive: true`: it then never sends the request itself (not on
 * mount, not when nothing is cached), but still sees every answer and error the query gets.
 */
export function useBuilding({ passive = false }: { passive?: boolean } = {}) {
  const buildingId = useBuildingId();
  return useQuery({
    queryKey: ['b', buildingId, 'building'],
    enabled: !passive,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}', { params: { path: { building_id: buildingId } }, signal }),
  });
}

/**
 * Whether the selected building is denied: a 401 or 404 on its own request, or a denial seen on any of its
 * requests that no building answer has come after. A later 5xx or network error leaves it denied; only a
 * successful building answer newer than the denial (or `reset()`, a switch) ends it. The guard, the nav and the
 * bell all read this one state (inbox B-5).
 */
export function useBuildingDenied(): boolean {
  const buildingId = useBuildingId();
  const queryClient = useQueryClient();
  const building = useBuilding({ passive: true });
  // Read without observing, so reading creates no cache entry.
  const subscribe = useCallback((onChange: () => void) => queryClient.getQueryCache().subscribe(onChange), [queryClient]);
  const deniedAt = useSyncExternalStore(subscribe, () => queryClient.getQueryData<number>(deniedKey(buildingId)) ?? 0);
  const status = building.error instanceof ApiError ? building.error.status : null;
  return status === 401 || status === 404 || deniedAt > building.dataUpdatedAt;
}
