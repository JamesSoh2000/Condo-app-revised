/**
 * A resident's maintenance API for the P6-04b tests: `/me` with an occupancy, the list from a mutable server state, the
 * create and cancel endpoints that record what they were sent, and the files API for photo uploads (`FakeXHR` answers
 * the S3 POST).
 */
import { act } from '@testing-library/react';

import type { components } from '@/api/schema';
import { MAPLE, RESIDENT_ME, buildingOut, json, membership, type Handler } from '@/test/renderApp';

type Schemas = components['schemas'];
export type MaintenanceRequest = Schemas['MaintenanceRequestOut'];
type BuildingRef = typeof MAPLE;

export const maintenanceBase = (building: BuildingRef = MAPLE) => `/api/buildings/${building.id}/maintenance-requests`;
export const OWN = membership(MAPLE).membership_id;
export const CO_OCCUPANT = '01929a4e-0000-7000-8000-0000000d0007';
export const U101 = '01929a4e-0000-7000-8000-0000000c0001';
export const OCCUPANCY: Schemas['MeOccupancyOut'] = { unit_id: U101, unit_label: '101', tower: 'A', relationship: 'tenant' };
export const FILES = Array.from({ length: 6 }, (_, i) => `01929a4e-0000-7000-8000-0000000a00${String(i + 1).padStart(2, '0')}`);

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

/** A test double for the browser's XHR (the S3 form POST): the test answers it. */
export class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  send() {
    FakeXHR.instances.push(this);
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number) {
    this.status = status;
    act(() => this.onload?.());
  }
  fail() {
    act(() => this.onerror?.());
  }
}

/** The files API of `building`: each `POST /files` hands out the next of `FILES`. */
export function uploadsApi(building: BuildingRef = MAPLE): Record<string, Handler> {
  const base = `/api/buildings/${building.id}/files`;
  const ids = [...FILES];
  const routes: Record<string, Handler> = {
    [`POST ${base}`]: () => {
      const id = ids.shift()!;
      return json(
        {
          file_id: id,
          upload: { url: 'http://localhost:4566/files', fields: { key: `k/${id}`, policy: 'p', 'Content-Type': 'image/jpeg' } },
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
        201,
      );
    },
  };
  for (const id of FILES) {
    routes[`POST ${base}/${id}/complete`] = () =>
      json({ id, purpose: 'maintenance_photo', status: 'ready', content_type: 'image/jpeg', size_bytes: 2048, original_name: 'leak.jpg', created_at: '2026-10-29T12:00:00Z' });
  }
  return routes;
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
  /** Every cancel's request id, in order. */
  cancelled: string[];
}

/**
 * The routes of a resident of `MAPLE` living in A-101 (or none, with `occupancy: null`). `create` and `cancel` answer
 * each call; by default a 201 echoing the body and a 200 with the request cancelled.
 */
export function residentWorld(
  world: World,
  {
    occupancy = OCCUPANCY,
    create,
    cancel,
  }: { occupancy?: Schemas['MeOccupancyOut'] | null; create?: Handler; cancel?: (id: string, request: Request) => Response | Promise<Response> } = {},
): Record<string, Handler> {
  const base = maintenanceBase();
  const routes: Record<string, Handler> = {
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
    ...uploadsApi(),
  };
  for (const item of world.items) {
    routes[`POST ${base}/${item.id}/cancel`] = async (request) => {
      world.cancelled.push(item.id);
      if (cancel) return cancel(item.id, request);
      const done = { ...item, status: 'cancelled' as const, cancelled_at: '2026-10-29T15:00:00Z' };
      world.items = world.items.map((other) => (other.id === item.id ? done : other));
      return json(done);
    };
  }
  return routes;
}

export const newWorld = (items: MaintenanceRequest[] = []): World => ({ items, created: [], cancelled: [] });
