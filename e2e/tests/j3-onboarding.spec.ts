import { randomUUID } from 'node:crypto';

import { expect, type NewContext, type Page, test } from '../helpers/test';

import { buildingId, NEW_PASSWORD, storageStatePath, uniqueEmail } from '../helpers/auth';
import { waitForEmail } from '../helpers/mailpit';

/** Maple's join code (backend/app/seed.py). */
const JOIN_LINK = '/join/MAPLE-2026';

/** Signs up through the join link and asks to join unit 402 as a tenant; ends on the pending screen. */
async function requestToJoin(page: Page, fullName: string, email: string) {
  await page.goto(JOIN_LINK);
  await page.getByLabel('Full name').fill(fullName);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByLabel('Unit number').fill('402');
  await page.getByRole('radio', { name: '402' }).check();
  await page.getByRole('radio', { name: /^Tenant/ }).check();
  await page.getByRole('button', { name: 'Send request' }).click();

  await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
  await expect(page.getByTestId('pending-request')).toContainText('Maple Tower');
}

/** Opens the manager's pending requests in the manager's own context and decides the request from `fullName`. */
async function decide(newContext: NewContext, fullName: string, decision: 'Approve' | 'Deny', reason?: string) {
  const context = await newContext({ storageState: storageStatePath('mapleManager') });
  const page = await context.newPage();
  await page.goto('/manage/residents');
  // Journeys run in parallel: the list may hold other journeys' requests, so the row is found by this one's name.
  await page.getByRole('button', { name: `${decision} ${fullName}` }).click();
  const dialog = page.getByRole('dialog');
  if (reason) await dialog.getByLabel('Reason (they will see it)').fill(reason);
  await dialog.getByRole('button', { name: decision, exact: true }).click();
  await expect(page.getByTestId('decision-message')).toContainText(fullName);
  await context.close();
}

function newName(label: string) {
  return `${label} ${randomUUID().slice(0, 6)}`;
}

test('J3: a resident joins with the link, is approved, is notified and reaches home; Birch cannot see them', async ({
  page,
  newContext,
}) => {
  const fullName = newName('Ari Approved');
  const email = uniqueEmail('j3-approved');
  await requestToJoin(page, fullName, email);

  await decide(newContext, fullName, 'Approve');

  await waitForEmail(email, 'Your join request was approved');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Maple Tower')).toBeVisible();
  // The in-app notification, from the bell.
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByText('Your join request was approved')).toBeVisible();

  // Tenancy (ADR-0004): Birch's manager can't open Maple's members (404, not 403), and Birch's own list doesn't
  // include the new resident.
  const birch = await newContext({ storageState: storageStatePath('birchManager') });
  const residentMaple = await buildingId(page.request, 'maple');
  const crossBuilding = await birch.request.get(`/api/buildings/${residentMaple}/members`, { params: { search: email } });
  expect(crossBuilding.status()).toBe(404);
  const birchId = await buildingId(birch.request, 'birch');
  const own = await birch.request.get(`/api/buildings/${birchId}/members`, { params: { search: email } });
  expect(own.status()).toBe(200);
  expect(((await own.json()) as { items: unknown[] }).items).toHaveLength(0);
  await birch.close();
});

test('J3 deny: a declined resident is told by email and sees the reason', async ({ page, newContext }) => {
  const fullName = newName('Dana Declined');
  const email = uniqueEmail('j3-denied');
  const reason = 'We could not match you to unit 402.';
  await requestToJoin(page, fullName, email);

  await decide(newContext, fullName, 'Deny', reason);

  await waitForEmail(email, 'Your join request was declined');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your request was not approved' })).toBeVisible();
  await expect(page.getByTestId('denied-reason')).toHaveText(`Reason: ${reason}`);
});
