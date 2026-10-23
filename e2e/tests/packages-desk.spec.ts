import { randomBytes } from 'node:crypto';

import { expect, type Locator, type NewContext, type Page, test } from '../helpers/test';

import { buildingId, storageStatePath } from '../helpers/auth';
import { createUnit, logPackage, type PackageOut } from '../helpers/packages';

/**
 * Not a journey: the package desk's layout and dialogs in a real browser, which P5-03d checked only by hand (the
 * P5-05 carry). Each test makes its own unit, so no journey's badge or list sees its packages, and both projects can
 * run it at once. The desk is Maple's security; the second desk is Maple's manager (both may hand out, P5-02b).
 */

/** Letters and digits with no break opportunity, `length` long and unique to this run. */
function unbroken(length: number): string {
  return `W${randomBytes(length).toString('hex').toUpperCase()}`.slice(0, length);
}

interface Setup {
  maple: string;
  unit: { id: string; name: string };
}

/** A unit with the longest tower and label the API takes (`units.tower`, `units.label` varchar(20)). */
async function longUnit(newContext: NewContext, baseURL: string): Promise<Setup> {
  const manager = await newContext({ storageState: storageStatePath('mapleManager') });
  const maple = await buildingId(manager.request, 'maple');
  const unit = { tower: unbroken(20), label: unbroken(20) };
  const id = await createUnit(manager.request, baseURL, maple, unit);
  await manager.close();
  // As the app writes it (`unitName`).
  return { maple, unit: { id, name: `${unit.tower}-${unit.label}` } };
}

/** Logs `count` packages at the unit as the desk, through the API, with the longest values the API takes. */
async function longPackages(newContext: NewContext, baseURL: string, setup: Setup, count: number) {
  const desk = await newContext({ storageState: storageStatePath('mapleSecurity') });
  const packages: PackageOut[] = [];
  for (let i = 0; i < count; i++) {
    packages.push(
      await logPackage(desk.request, baseURL, setup.maple, {
        unit_id: setup.unit.id,
        carrier: unbroken(50),
        description: unbroken(200),
        tracking_last4: 'ZZ99',
      }),
    );
  }
  await desk.close();
  return packages;
}

/** Opens the desk page with the waiting list narrowed to the unit. */
async function openDesk(page: Page, unitName: string) {
  await page.goto('/security/packages');
  const label = unitName.split('-')[1];
  await page.getByLabel('Unit number', { exact: true }).fill(label);
  // The list's own picker, not the Log package panel's.
  await page.getByRole('group', { name: 'Show packages for' }).getByRole('radio', { name: unitName, exact: true }).check();
}

/** Neither the page nor `target` is wider than the viewport, and `target` has no hidden horizontal overflow. */
async function expectFits(page: Page, target: Locator, what: string) {
  await expect(target).toBeVisible();
  const box = await target.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    left: el.getBoundingClientRect().left,
    right: el.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  const width = page.viewportSize()!.width;
  expect(box.scroll, `${what} at ${width} px: its scrollWidth`).toBeLessThanOrEqual(box.client);
  expect(box.left, `${what} at ${width} px: its left edge`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${what} at ${width} px: its right edge`).toBeLessThanOrEqual(box.viewport);
  expect(box.page, `the page at ${width} px with ${what}: its scrollWidth`).toBeLessThanOrEqual(box.viewport);
}

function actionButton(page: Page, kind: 'Hand out' | 'Return', item: PackageOut, unitName: string) {
  return page.getByRole('button', { name: `${kind} the ${item.carrier} package for unit ${unitName}` });
}

test('the desk page, both dialogs and the outcome messages fit 375 and 768 px with the longest values', async ({
  newContext,
  baseURL,
}) => {
  const setup = await longUnit(newContext, baseURL!);
  const packages = await longPackages(newContext, baseURL!, setup, 4);
  const desk = await newContext({ storageState: storageStatePath('mapleSecurity') });
  const deskPage = await desk.newPage();
  const name = setup.unit.name;

  for (const [width, [toReturn, toHandOut]] of [
    [375, packages.slice(0, 2)],
    [768, packages.slice(2, 4)],
  ] as const) {
    await deskPage.setViewportSize({ width, height: 900 });
    await openDesk(deskPage, name);
    const list = deskPage.getByRole('list', { name: 'Waiting packages' });
    await expect(actionButton(deskPage, 'Return', toReturn, name)).toBeVisible();
    await expect(actionButton(deskPage, 'Hand out', toHandOut, name)).toBeVisible();
    await expectFits(deskPage, list, 'the waiting list');

    // Return, with the longest reason (`return_reason` varchar(300)).
    await actionButton(deskPage, 'Return', toReturn, name).click();
    const returnDialog = deskPage.getByRole('dialog');
    await returnDialog.getByLabel('Reason').fill(unbroken(300));
    await expectFits(deskPage, returnDialog, 'the Return dialog');
    await returnDialog.getByRole('button', { name: 'Return', exact: true }).click();
    const message = deskPage.getByTestId('package-message');
    await expect(message).toHaveText(`Unit ${name}’s package was marked returned.`);
    await expectFits(deskPage, message, 'the return message');

    // Hand out, to the longest typed name (`picked_up_by_name` varchar(120)).
    const who = unbroken(120);
    await actionButton(deskPage, 'Hand out', toHandOut, name).click();
    const pickupDialog = deskPage.getByRole('dialog');
    await pickupDialog.getByRole('radio', { name: 'Someone else' }).check();
    await pickupDialog.getByLabel('Their name').fill(who);
    await expectFits(deskPage, pickupDialog, 'the Hand out dialog');
    await pickupDialog.getByRole('button', { name: 'Hand out', exact: true }).click();
    await expect(message).toHaveText(`Unit ${name}’s package was handed to ${who}.`);
    await expectFits(deskPage, message, 'the pickup message');
  }
});

test('two desks hand out one package: one wins, the other is told and its row goes; dialogs take focus', async ({
  newContext,
  baseURL,
}) => {
  const setup = await longUnit(newContext, baseURL!);
  const [raced, gone] = await longPackages(newContext, baseURL!, setup, 2);
  const name = setup.unit.name;
  const a = await (await newContext({ storageState: storageStatePath('mapleSecurity') })).newPage();
  const b = await (await newContext({ storageState: storageStatePath('mapleManager') })).newPage();
  await openDesk(a, name);
  await openDesk(b, name);

  // Both open Hand out on the same package. The dialog takes focus on open (P5-03d R1 F1: nothing is chosen for the
  // desk), and Shift+Tab from the radio group stays inside it.
  for (const page of [a, b]) {
    await actionButton(page, 'Hand out', raced, name).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeFocused();
    await dialog.getByRole('radio', { name: 'Someone else' }).check();
    await dialog.getByRole('radio', { name: 'Someone else' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await a.getByRole('dialog').getByLabel('Their name').fill('Desk A visitor');
  await a.getByRole('dialog').getByRole('button', { name: 'Hand out', exact: true }).click();
  await expect(a.getByTestId('package-message')).toHaveText(`Unit ${name}’s package was handed to Desk A visitor.`);

  // B confirms second: the server's 409 is the message, focus moves to it, and B's list drops the row.
  await b.getByRole('dialog').getByLabel('Their name').fill('Desk B visitor');
  await b.getByRole('dialog').getByRole('button', { name: 'Hand out', exact: true }).click();
  await expect(b.getByTestId('package-message')).toHaveText('Already picked up or returned by a colleague.');
  await expect(b.getByTestId('package-message')).toBeFocused();
  await expect(b.getByRole('dialog')).toHaveCount(0);
  await expect(actionButton(b, 'Hand out', raced, name)).toHaveCount(0);

  // The Return dialog takes focus on its reason.
  await actionButton(a, 'Return', gone, name).click();
  await expect(a.getByRole('dialog').getByLabel('Reason')).toBeFocused();
  await a.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // B opens Hand out on the other package; A hands it out; B's list refreshes (the tab regains focus) and the row
  // leaves under the open dialog. Cancel then closes it with focus on the list's heading, and no message.
  await actionButton(b, 'Hand out', gone, name).click();
  await expect(b.getByRole('dialog')).toBeFocused();
  await actionButton(a, 'Hand out', gone, name).click();
  await a.getByRole('dialog').getByRole('radio', { name: 'Someone else' }).check();
  await a.getByRole('dialog').getByLabel('Their name').fill('Desk A visitor');
  await a.getByRole('dialog').getByRole('button', { name: 'Hand out', exact: true }).click();
  await expect(a.getByTestId('package-message')).toHaveText(`Unit ${name}’s package was handed to Desk A visitor.`);
  await b.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(actionButton(b, 'Hand out', gone, name)).toHaveCount(0);
  await expect(b.getByRole('dialog')).toBeVisible();
  await b.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(b.getByRole('dialog')).toHaveCount(0);
  await expect(b.getByRole('heading', { name: 'Waiting', exact: true })).toBeFocused();
  await expect(b.getByTestId('package-message')).toHaveCount(0);
});
