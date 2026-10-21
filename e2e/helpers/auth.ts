import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

/** Every seeded account's password in dev (README "Seed data"). */
export const SEED_PASSWORD = 'DevPassword!2026';

/** Seeded accounts the journeys share. They log in once per run (`tests/auth.setup.ts`), so the login rate limits hold. */
export const PERSONAS = {
  mapleManager: 'manager@example.test',
  birchManager: 'birch.manager@example.test',
} as const;
export type Persona = keyof typeof PERSONAS;

/** Where `auth.setup.ts` saves a persona's cookies, for `test.use({ storageState })`. */
export function storageStatePath(persona: Persona): string {
  return path.join(import.meta.dirname, '..', '.auth', `${persona}.json`);
}

/** An address no other journey, project or retry uses, so each journey's emails are its own. */
export function uniqueEmail(label: string): string {
  return `e2e-${label}-${randomUUID().slice(0, 8)}@example.test`;
}

/** A strong password the policy accepts. */
export const NEW_PASSWORD = 'E2e-Journey-Password-2026!';

/**
 * The headers the SPA's client sends on unsafe calls: the CSRF check needs `X-Requested-With: fetch` and a trusted
 * Origin (ADR-0003). `baseURL` is the SPA's origin.
 */
function spaHeaders(baseURL: string): Record<string, string> {
  return { 'X-Requested-With': 'fetch', Origin: new URL(baseURL).origin };
}

/** POSTs JSON as the SPA would, with the context's cookies. */
export function apiPost(api: APIRequestContext, baseURL: string, url: string, data: unknown): Promise<APIResponse> {
  return api.post(url, { data, headers: spaHeaders(baseURL) });
}

/** Logs `email` in through the API: the context gets the session cookie. */
export async function apiLogin(api: APIRequestContext, baseURL: string, email: string, password = SEED_PASSWORD) {
  const response = await apiPost(api, baseURL, '/api/auth/login', { email, password });
  expect(response.status(), `login as ${email}`).toBe(204);
}

/** Creates an account through the API; the context is signed in as it (signup logs in). */
export async function apiSignup(api: APIRequestContext, baseURL: string, email: string, fullName: string) {
  const response = await apiPost(api, baseURL, '/api/auth/signup', { email, full_name: fullName, password: NEW_PASSWORD });
  expect(response.status(), `signup as ${email}`).toBe(201);
}

interface Me {
  memberships: { membership_id: string; status: string; building: { id: string; slug: string } }[];
}

/** The id of the building `slug` among the signed-in user's memberships. */
export async function buildingId(api: APIRequestContext, slug: string): Promise<string> {
  const response = await api.get('/api/auth/me');
  expect(response.status()).toBe(200);
  const me = (await response.json()) as Me;
  const membership = me.memberships.find((m) => m.building.slug === slug);
  if (!membership) throw new Error(`not a member of ${slug}`);
  return membership.building.id;
}
