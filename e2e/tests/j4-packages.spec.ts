import { expect, type NewContext, type Page, test } from '../helpers/test';

import { apiPost, buildingId, PERSONAS, type Persona, storageStatePath } from '../helpers/auth';
import { extractLink, waitForEmail } from '../helpers/mailpit';
import { packagesPath, type PackageOut, PHOTO_PNG, uniqueCarrier, waitingCount } from '../helpers/packages';

/**
 * Each project logs its package for its own unit, so the two runs at once don't move each other's resident's badge
 * (PR D1): `chromium` takes unit 101, as the ticket says, `mobile` unit 304. Both units' residents are seeded
 * (backend/app/seed.py).
 */
const UNITS: Record<string, { unit: string; resident: Persona; name: string }> = {
  chromium: { unit: '101', resident: 'resident101', name: 'Alex Chen' },
  mobile: { unit: '304', resident: 'resident304', name: 'Taylor Nguyen' },
};

/** The nav's "My packages" link, whose accessible name carries the waiting count (PackagesNavLabel). */
function myPackagesLink(page: Page) {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^My packages/ });
}

function badgeName(count: number) {
  return count === 0 ? 'My packages' : `My packages, ${count} waiting`;
}

test('J4: the desk logs a package with a photo; the resident is told in-app and by email, opens it, and it is handed out', async ({
  newContext,
  baseURL,
}, testInfo) => {
  const { unit, resident, name } = UNITS[testInfo.project.name];
  const carrier = uniqueCarrier();

  // The resident, on their packages page, with the count before this run's package.
  const residentContext = await newContext({ storageState: storageStatePath(resident) });
  const residentPage = await residentContext.newPage();
  const maple = await buildingId(residentContext.request, 'maple');
  const before = await waitingCount(residentContext.request, maple);
  await residentPage.goto('/packages');
  await expect(myPackagesLink(residentPage)).toHaveAccessibleName(badgeName(before));

  // The desk logs it through the Log package panel, with a photo uploaded to the S3 emulator.
  const deskContext = await newContext({ storageState: storageStatePath('mapleSecurity') });
  const desk = await deskContext.newPage();
  await desk.goto('/security/packages');
  const panel = desk.getByRole('region', { name: 'Log package' });
  await panel.getByLabel('Unit', { exact: true }).fill(unit);
  await panel.getByRole('radio', { name: unit, exact: true }).check();
  await panel.getByRole('radio', { name: 'Other', exact: true }).check();
  await panel.getByLabel('Other carrier').fill(carrier);
  await panel.getByLabel('Description (optional)').fill('Brown box, E2E');
  const chooser = desk.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Choose photo' }).click();
  await (await chooser).setFiles({ name: 'parcel.png', mimeType: 'image/png', buffer: PHOTO_PNG });
  await expect(panel.getByRole('button', { name: 'Remove photo' })).toBeVisible();
  const created = desk.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === packagesPath(maple));
  await panel.getByRole('button', { name: 'Log package' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const pkg = (await response.json()) as PackageOut;
  expect(pkg.photo_file_id).not.toBeNull();
  await expect(panel.getByTestId('log-status')).toHaveText('Logged ✓');
  const handOut = desk.getByRole('button', { name: `Hand out the ${carrier} package for unit ${unit}` });
  await expect(handOut).toBeVisible();

  // The resident's badge rises by one, and the bell lists the notification.
  await residentPage.reload();
  await expect(myPackagesLink(residentPage)).toHaveAccessibleName(badgeName(before + 1));
  await residentPage.getByRole('button', { name: /^Notifications/ }).click();
  const notification = residentPage.getByRole('button', { name: new RegExp(`${carrier} delivered a package for unit ${unit}`) });
  await expect(notification).toBeVisible();

  // Its link opens the package, with the photo loaded through a presigned URL that expires in 60 seconds.
  await notification.click();
  await expect(residentPage).toHaveURL(`/packages/${pkg.id}`);
  const dialog = residentPage.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `${carrier} package` })).toBeVisible();
  await expect(dialog.getByText('Waiting at the front desk')).toBeVisible();
  const photo = dialog.getByRole('img', { name: `Package photo: ${carrier}` });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(16);
  const src = new URL((await photo.getAttribute('src'))!);
  expect(src.searchParams.get('X-Amz-Expires')).toBe('60');

  // The email names this run's carrier and links to the same package.
  const email = await waitForEmail(PERSONAS[resident], 'A package is waiting at the desk', { textIncludes: carrier });
  expect(email.text).toContain(`${new URL(baseURL!).origin}/packages/${pkg.id}`);
  expect(extractLink(email, '/packages/')).toBe(`/packages/${pkg.id}`);
  // The email's link opens it as well.
  await residentPage.goto(extractLink(email, '/packages/'));
  await expect(dialog.getByRole('heading', { name: `${carrier} package` })).toBeVisible();

  // The desk hands it out to the resident; it leaves the waiting list.
  await handOut.click();
  const handOutDialog = desk.getByRole('dialog');
  await handOutDialog.getByRole('radio', { name, exact: true }).check();
  await handOutDialog.getByRole('button', { name: 'Hand out', exact: true }).click();
  await expect(desk.getByTestId('package-message')).toHaveText(`Unit ${unit}’s package was handed to ${name}.`);
  await expect(handOut).toHaveCount(0);

  // The resident's badge falls back, and the package is in their history as picked up.
  await residentPage.goto('/packages');
  await expect(myPackagesLink(residentPage)).toHaveAccessibleName(badgeName(before));
  await expect(residentPage.getByRole('list', { name: 'Package history' }).getByRole('link', { name: new RegExp(`^Details: ${carrier} package, picked up`) })).toBeVisible();
  await residentPage.goto(`/packages/${pkg.id}`);
  // The status, and when: "Status Picked up", then "Picked up <time>".
  await expect(dialog.getByRole('definition').first()).toHaveText('Picked up');
  await expect(dialog.getByRole('term').filter({ hasText: /^Picked up$/ })).toBeVisible();

  // The resident may see it, but a desk action is security's (row 4).
  const asResident = await apiPost(residentContext.request, baseURL!, packagesPath(maple, `/${pkg.id}/pickup`), { picked_up_by_name: 'Me' });
  expect(asResident.status()).toBe(403);

  await privacy(newContext, maple, pkg);
});

/**
 * Who else asks for the package and its photo (10-case table rows 2–6, ADR-0004, ADR-0007): signed out 401; another
 * Maple unit's resident, a pending membership and Birch's manager 404; the resident who may see it 403 for a desk
 * action (in the journey). Run after the pickup, so the package's history is what they would find.
 */
async function privacy(newContext: NewContext, maple: string, pkg: PackageOut) {
  const photoUrl = `/api/buildings/${maple}/files/${pkg.photo_file_id}/download-url`;

  const anonymous = await newContext();
  expect((await anonymous.request.get(packagesPath(maple, `/${pkg.id}`))).status()).toBe(401);

  // resident2 lives in unit 102: same building, someone else's package.
  const neighbour = await newContext({ storageState: storageStatePath('resident102') });
  expect((await neighbour.request.get(packagesPath(maple, `/${pkg.id}`))).status()).toBe(404);
  expect((await neighbour.request.get(photoUrl)).status()).toBe(404);
  const neighbourPage = await neighbour.newPage();
  await neighbourPage.goto(`/packages/${pkg.id}`);
  await expect(neighbourPage.getByRole('dialog').getByRole('heading', { name: 'Package not found' })).toBeVisible();
  await expect(neighbourPage.getByRole('img', { name: /^Package photo/ })).toHaveCount(0);

  const pending = await newContext({ storageState: storageStatePath('pendingResident') });
  expect((await pending.request.get(packagesPath(maple, `/${pkg.id}`))).status()).toBe(404);
  expect((await pending.request.get(photoUrl)).status()).toBe(404);

  const birch = await newContext({ storageState: storageStatePath('birchManager') });
  const birchId = await buildingId(birch.request, 'birch');
  expect((await birch.request.get(packagesPath(maple, `/${pkg.id}`))).status()).toBe(404);
  expect((await birch.request.get(photoUrl)).status()).toBe(404);
  // Maple's ids under Birch's own path are no better.
  expect((await birch.request.get(packagesPath(birchId, `/${pkg.id}`))).status()).toBe(404);
  expect((await birch.request.get(`/api/buildings/${birchId}/files/${pkg.photo_file_id}/download-url`)).status()).toBe(404);
}
