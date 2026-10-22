import { expect, type Locator, type Page, test } from '../helpers/test';

import { storageStatePath } from '../helpers/auth';

// P4-08h: the header's two panels at phone width and above. Maple's manager has a building, so both the bell and
// the account menu show. Measured in CSS pixels against the layout viewport.
test.use({ storageState: storageStatePath('mapleManager') });

const HEIGHT = 800;

interface Panels {
  bell: Locator;
  bellPanel: Locator;
  account: Locator;
  accountPanel: Locator;
}

async function openHome(page: Page, width: number): Promise<Panels> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto('/');
  const bell = page.getByRole('button', { name: /^Notifications/ });
  const account = page.getByRole('button', { name: /Account menu/ });
  await expect(bell).toBeVisible();
  // The panels' ids come from `useId` (":r1:"), so they are matched as attribute values, not CSS ids.
  const panel = async (button: Locator) => page.locator(`[id="${await button.getAttribute('aria-controls')}"]`);
  return { bell, bellPanel: await panel(bell), account, accountPanel: await panel(account) };
}

async function box(locator: Locator) {
  const rect = await locator.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
  return { left: rect.left, right: rect.right, width: rect.width, bottom: rect.bottom };
}

async function viewport(page: Page) {
  return page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
}

/** Criterion 1's checks: inside the viewport, on the header's content box, and no horizontal scroll. */
async function expectPhoneFit(page: Page, panel: Locator, label: string) {
  await expect(panel).toBeVisible();
  const { clientWidth, scrollWidth } = await viewport(page);
  const rect = await box(panel);
  expect(rect.left, `${label} left`).toBeGreaterThanOrEqual(0);
  expect(rect.right, `${label} right`).toBeLessThanOrEqual(clientWidth);
  expect(rect.left, `${label} left`).toBeCloseTo(16, 0);
  expect(rect.right, `${label} right`).toBeCloseTo(clientWidth - 16, 0);
  expect(scrollWidth, `${label}: horizontal scroll`).toBeLessThanOrEqual(clientWidth);
  // The bell's panel scrolls itself (`overflow-y-auto` makes x `auto` too): text wider than it would scroll inside it.
  const inner = await panel.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(inner.scrollWidth, `${label}: scrolls sideways`).toBeLessThanOrEqual(inner.clientWidth);
}

/** A tap where the `mobile` project has a touchscreen, a click elsewhere. */
async function press(page: Page, x: number, y: number) {
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

for (const width of [320, 375, 412]) {
  test(`inside the viewport at ${width} px`, async ({ page }) => {
    const { bell, bellPanel, account, accountPanel } = await openHome(page, width);

    await bell.click();
    await expectPhoneFit(page, bellPanel, 'bell panel');
    await bell.click();
    await expect(bellPanel).toBeHidden();

    await account.click();
    await expectPhoneFit(page, accountPanel, 'account menu');
  });
}

for (const width of [640, 1280]) {
  test(`wider screens keep the panels under their buttons at ${width} px`, async ({ page }) => {
    const { bell, bellPanel, account, accountPanel } = await openHome(page, width);

    await bell.click();
    await expect(bellPanel).toBeVisible();
    const bellRect = await box(bellPanel);
    expect(bellRect.width).toBeCloseTo(320, 0);
    expect(bellRect.right).toBeCloseTo((await box(bell.locator('..'))).right, 0);
    expect(bellRect.left).toBeGreaterThanOrEqual(0);
    await bell.click();

    await account.click();
    await expect(accountPanel).toBeVisible();
    const accountRect = await box(accountPanel);
    expect(accountRect.width).toBeCloseTo(256, 0);
    expect(accountRect.right).toBeCloseTo((await box(account)).right, 0);
    expect(accountRect.right).toBeLessThanOrEqual((await viewport(page)).clientWidth);
  });
}

test('a tap below an open panel closes it, and the next tap follows a nav link', async ({ page }) => {
  const panels = await openHome(page, 375);
  const residents = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Residents/ });

  for (const [button, panel] of [
    [panels.bell, panels.bellPanel],
    [panels.account, panels.accountPanel],
  ] as const) {
    await button.click();
    await expect(panel).toBeVisible();
    // The panel lies over the nav link.
    const link = await box(residents);
    expect((await box(panel)).bottom).toBeGreaterThan(link.bottom);

    // In the main area's left padding, under the panel: nothing there to follow.
    await press(page, 8, (await box(panel)).bottom + 24);
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  }

  const link = await residents.boundingBox();
  await press(page, link!.x + link!.width / 2, link!.y + link!.height / 2);
  await expect(page).toHaveURL(/\/manage\/residents/);
});

test('long text wraps inside the panels', async ({ page }) => {
  const longEmail = `${'a'.repeat(241)}@example.test`;
  expect(longEmail).toHaveLength(254);
  // No seeded account has such values: the stack's real answers are rewritten in the browser.
  await page.route('**/api/auth/me', async (route) => {
    const response = await route.fetch();
    const me = await response.json();
    me.user.email = longEmail;
    await route.fulfill({ response, json: me });
  });
  await page.route(/\/api\/buildings\/[^/]+\/notifications(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const now = new Date().toISOString();
    const item = {
      id: '00000000-0000-7000-8000-000000000001',
      kind: 'e2e.long',
      title: 'T'.repeat(200),
      body: 'B'.repeat(1000),
      link: null,
      entity_type: null,
      entity_id: null,
      read_at: now,
      created_at: now,
    };
    await route.fulfill({ response, json: { items: [item], next_cursor: null } });
  });
  const { bell, bellPanel, account, accountPanel } = await openHome(page, 375);

  await bell.click();
  await expect(bellPanel.getByText('T'.repeat(200))).toBeVisible();
  await expectPhoneFit(page, bellPanel, 'bell panel');
  await bell.click();

  await account.click();
  await expect(accountPanel.getByText(longEmail)).toBeVisible();
  await expectPhoneFit(page, accountPanel, 'account menu');
});
