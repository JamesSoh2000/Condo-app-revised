/**
 * One maintenance request's API for the P6-04c tests: the list, the request, its status events and its comments, each
 * answer from a mutable server state (or a handler that overrides it), so a test can change what the next read says.
 */
import type { components } from '@/api/schema';
import { maintenanceBase, maintenanceRequest, type MaintenanceRequest } from '@/test/maintenance';
import { MAPLE, RESIDENT_ME, buildingOut, json, membership, type Handler } from '@/test/renderApp';

type Schemas = components['schemas'];
export type Comment = Schemas['MaintenanceCommentOut'];
export type StatusEvent = Schemas['MaintenanceStatusEventOut'];
type Role = Schemas['Role'];
type BuildingRef = typeof MAPLE;

export const REQUEST = maintenanceRequest(1, { description: 'Kitchen tap drips' });

let serial = 0;
const nextId = (block: string) => `01929a4e-0000-7000-8000-0000${block}${String(++serial).padStart(4, '0')}`;

export function comment(at: string, fields: Partial<Comment> = {}): Comment {
  return {
    id: nextId('0a'),
    request_id: REQUEST.id,
    body: 'A comment',
    is_internal: false,
    created_at: at,
    author_name: null,
    author_is_staff: true,
    ...fields,
  };
}

export function statusEvent(at: string, from_status: StatusEvent['from_status'], status: StatusEvent['status']): StatusEvent {
  return { id: nextId('0b'), request_id: REQUEST.id, from_status, status, at };
}

export interface ViewState {
  request: MaintenanceRequest;
  events: StatusEvent[];
  comments: Comment[];
}

export const viewState = (fields: Partial<ViewState> = {}): ViewState => ({ request: REQUEST, events: [], comments: [], ...fields });

/** Pages of `items` by `limit` and an opaque cursor (the index of the next item), as the API's oldest-first pages. */
function paged<T>(request: Request, items: T[]): Response {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const start = Number(url.searchParams.get('cursor') ?? 0);
  const next = start + limit < items.length ? String(start + limit) : null;
  return json({ items: items.slice(start, start + limit), next_cursor: next });
}

/** The routes of the request in `state`, in `building`. */
export function viewRoutes(state: ViewState, building: BuildingRef = MAPLE): Record<string, Handler> {
  const base = maintenanceBase(building);
  const one = `${base}/${state.request.id}`;
  return {
    [`GET ${base}`]: () => json({ items: [state.request], next_cursor: null }),
    [`GET ${one}`]: () => json(state.request),
    [`GET ${one}/status-events`]: (request) => paged(request, state.events),
    [`GET ${one}/comments`]: (request) => paged(request, state.comments),
  };
}

/** A member of `MAPLE` with `roles` (a resident by default), and the request's routes. */
export function memberWorld(state: ViewState, roles: Role[] = ['resident'], overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
    ...viewRoutes(state),
    ...overrides,
  };
}
