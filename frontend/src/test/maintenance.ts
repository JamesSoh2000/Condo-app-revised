/**
 * A resident's maintenance API for the P6-04b tests: `/me` with an occupancy, the list from a mutable server state, and
 * the create endpoint, which records what it was sent.
 */
import type { components } from '@/api/schema';
import { MAPLE, RESIDENT_ME, buildingOut, json, membership, type Handler } from '@/test/renderApp';

type Schemas = components['schemas'];
export type MaintenanceRequest = Schemas['MaintenanceRequestOut'];
type BuildingRef = typeof MAPLE;

export const maintenanceBase = (building: BuildingRef = MAPLE) => `/api/buildings/${building.id}/maintenance-requests`;
export const OWN = membership(MAPLE).membership_id;
export const U101 = '01929a4e-0000-7000-8000-0000000c0001';
export const OCCUPANCY: Schemas['MeOccupancyOut'] = { unit_id: U101, unit_label: '101', tower: 'A', relationship: 'tenant' };

export function maintenanceRequest(n: number, fields: Partial<MaintenanceRequest> = {}): MaintenanceRequest {
  return {
    id: `01929a4e-0000-7000-8000-0000000f00${String(n).padStart(2, '0')}`,
    requester_membership_id: OWN,
    location: 'unit',
    unit_id: U101,
    common_area: null,
    category: 'plumbing',
    description: `Request ${n}`,
    status: 'submitted',
    submitted_at: '2026-10-20T14:00:00Z',
    started_at: null,
    on_hold_at: null,
    resolved_at: null,
    cancelled_at: null,
    photo_file_ids: [],
    unit_tower: 'A',
    unit_label: '101',
    requester_name: null,
    emergency_phone: null,
    ...fields,
  };
}

export interface Sent {
  key: string | null;
  body: Record<string, unknown>;
}

export interface World {
  /** What the list answers; a create that answers 201 puts its request first. */
  items: MaintenanceRequest[];
  /** Every create's key and body, in order. */
  created: Sent[];
}

/**
 * The routes of a resident of `MAPLE` living in A-101 (or none, with `occupancy: null`). `create` answers each create;
 * by default a 201 echoing the body.
 */
export function residentWorld(
  world: World,
  {
    occupancy = OCCUPANCY,
    create,
  }: { occupancy?: Schemas['MeOccupancyOut'] | null; create?: Handler } = {},
): Record<string, Handler> {
  const base = maintenanceBase();
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [{ ...membership(MAPLE), occupancy }] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['resident'])),
    [`GET ${base}`]: () => json({ items: world.items, next_cursor: null }),
    [`POST ${base}`]: async (request) => {
      const body = (await request.clone().json()) as Record<string, unknown>;
      world.created.push({ key: request.headers.get('idempotency-key'), body });
      if (create) return create(request);
      const made = maintenanceRequest(90, {
        ...(body as Partial<MaintenanceRequest>),
        unit_tower: body.location === 'unit' ? 'A' : null,
        unit_label: body.location === 'unit' ? '101' : null,
      });
      world.items = [made, ...world.items];
      return json(made, 201);
    },
  };
}

export const newWorld = (items: MaintenanceRequest[] = []): World => ({ items, created: [] });
