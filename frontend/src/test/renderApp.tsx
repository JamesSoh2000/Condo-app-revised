/**
 * Test helpers for the app shell: a fetch stub that answers by "METHOD /path", and the shell's routes
 * rendered in a MemoryRouter with the app's providers. Test files must also mock `@/api/client` with an
 * absolute baseUrl (Node's Request rejects relative URLs); see shell.test.tsx.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router-dom';
import { vi } from 'vitest';

import type { components } from '@/api/schema';
import { AuthProvider } from '@/app/AuthProvider';
import { createQueryClient } from '@/app/queryClient';
import { AppRoutes } from '@/app/routes';

export type Handler = (request: Request) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function problem(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, request_id: 'req' }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
  });
}

export const noContent = (): Response => new Response(null, { status: 204 });

type Schemas = components['schemas'];
type Membership = Schemas['MeMembershipOut'];

export const MAPLE = { id: '01929a4e-0000-7000-8000-00000000a001', name: 'Maple Tower', slug: 'maple' };
export const BIRCH = { id: '01929a4e-0000-7000-8000-00000000b001', name: 'Birch Court', slug: 'birch' };
type BuildingRef = typeof MAPLE;

/** A `/me` membership in `building`; active resident unless overridden. */
export function membership(
  building: BuildingRef,
  { status = 'active', roles = ['resident'] }: { status?: Membership['status']; roles?: Schemas['Role'][] } = {},
): Membership {
  return {
    membership_id: building.id.replace(/1$/, '2'),
    status,
    roles,
    building: { ...building, timezone: 'America/Toronto', locale: 'en' },
    occupancy: null,
  };
}

/** `GET /api/buildings/{id}`'s body for `building`. */
export function buildingOut(
  building: BuildingRef,
  my_roles: Schemas['Role'][],
  features: Schemas['Feature'][] = ['packages', 'notices', 'maintenance'],
): Schemas['BuildingOut'] {
  return { ...building, timezone: 'America/Toronto', locale: 'en', my_roles, features };
}

export const RESIDENT_ME: Schemas['MeOut'] = {
  user: {
    id: '01929a4e-0000-7000-8000-000000000001',
    email: 'resident1@example.test',
    full_name: 'Alex Chen',
    phone: null,
    locale: 'en',
  },
  memberships: [membership(MAPLE)],
};

/**
 * Answered unless a test overrides it: `RESIDENT_ME`'s building, its unread count and the pending counts, so a test about something
 * else can render a page (P2-06b: pages need an active membership and the building's roles).
 */
const DEFAULT_ROUTES: Record<string, Handler> = {
  [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['resident'])),
  // The header's bell asks once the building is loaded (P3-05).
  [`GET /api/buildings/${MAPLE.id}/notifications/summary`]: () => json({ unread_count: 0 }),
  // A resident's nav asks for the waiting packages count (P5-04).
  [`GET /api/buildings/${MAPLE.id}/packages/summary`]: () => json({ waiting: 0 }),
  [`GET /api/buildings/${BIRCH.id}/packages/summary`]: () => json({ waiting: 0 }),
  // A property manager's nav asks for the pending count (P4-08d).
  [`GET /api/buildings/${MAPLE.id}/onboarding-requests/summary`]: () => json({ pending_onboarding_count: 0 }),
  [`GET /api/buildings/${BIRCH.id}/onboarding-requests/summary`]: () => json({ pending_onboarding_count: 0 }),
};

/** Stubs `fetch`; unknown routes fail the test loudly. Returns the mock to inspect calls. */
export function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (request: Request) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = routes[key] ?? DEFAULT_ROUTES[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(request);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The "METHOD /path" of every request made so far. */
export function calls(fetchMock: ReturnType<typeof stubApi>): string[] {
  return fetchMock.mock.calls.map(([request]) => `${request.method} ${new URL(request.url).pathname}`);
}

export interface RenderedApp {
  queryClient: QueryClient;
  /** The router's navigate, to simulate Back (`navigate(-1)`) and links. */
  navigate: () => NavigateFunction;
  /** The router's current location, with its history `state`. */
  location: () => Location;
}

/**
 * Renders the shell's routes at `entries` (a history; the last one is current). An entry can be a
 * `{ pathname, state }` object, for a history entry that carries router state.
 */
export function renderApp(entries: (string | Partial<Location>)[]): RenderedApp {
  const queryClient = createQueryClient({ retryDelay: 0 });
  let navigate: NavigateFunction | undefined;
  let current: Location | undefined;
  function Probe() {
    navigate = useNavigate();
    const location = useLocation();
    current = location;
    return <div data-testid="location">{location.pathname + location.search}</div>;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <AuthProvider>
          <AppRoutes />
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, navigate: () => navigate!, location: () => current! };
}

/** Opens the header's account menu (P2-06c), where the building switcher, "view as" and "Log out" are. */
export function openAccountMenu(): void {
  const button = screen.getByRole('button', { name: /account menu/i });
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
}
