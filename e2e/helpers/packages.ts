import { randomUUID } from 'node:crypto';

import { expect, type APIRequestContext } from '@playwright/test';

import { apiPost } from './auth';

/** A 16×16 PNG: a package photo the files API accepts (`package_photo` takes images). */
export const PHOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM4UaFBEmIY1TCqYfhqAAADaGgQ43GRdgAAAABJRU5ErkJggg==',
  'base64',
);

/** A carrier no other run or project uses (`packages.carrier` holds 50), so a journey finds its own package. */
export function uniqueCarrier(): string {
  return `E2E ${randomUUID().slice(0, 8)}`;
}

/** The fields of `PackageOut` the specs read. */
export interface PackageOut {
  id: string;
  status: 'received' | 'picked_up' | 'returned';
  carrier: string;
  photo_file_id: string | null;
}

/** `/api/buildings/{id}/packages…` */
export function packagesPath(buildingId: string, rest = ''): string {
  return `/api/buildings/${buildingId}/packages${rest}`;
}

/** How many packages the signed-in member may see are waiting (the badge's count). */
export async function waitingCount(api: APIRequestContext, buildingId: string): Promise<number> {
  const response = await api.get(packagesPath(buildingId, '/summary'));
  expect(response.status()).toBe(200);
  return ((await response.json()) as { waiting: number }).waiting;
}

/** Creates a unit as a manager and returns its id. */
export async function createUnit(api: APIRequestContext, baseURL: string, buildingId: string, unit: { tower: string; label: string }) {
  const response = await apiPost(api, baseURL, `/api/buildings/${buildingId}/units`, unit);
  expect(response.status(), `create unit ${unit.tower} ${unit.label}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Logs a package as the desk, through the API, and returns it. */
export async function logPackage(
  api: APIRequestContext,
  baseURL: string,
  buildingId: string,
  body: { unit_id: string; carrier: string; description?: string; tracking_last4?: string },
): Promise<PackageOut> {
  // The API requires a key per logging, as the Log package panel sends one (P5-02a).
  const response = await apiPost(api, baseURL, packagesPath(buildingId), body, { 'Idempotency-Key': randomUUID() });
  expect(response.status(), `log a package: ${await response.text()}`).toBe(201);
  return (await response.json()) as PackageOut;
}
