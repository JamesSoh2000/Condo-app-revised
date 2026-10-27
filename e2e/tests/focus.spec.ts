import { randomBytes } from 'node:crypto';

import { expect, type Page, test } from '../helpers/test';

import { buildingId, storageStatePath } from '../helpers/auth';
import { expectFocusKept, trackRequests } from '../helpers/focus';
import { createUnit, logPackage } from '../helpers/packages';

/**
 * Not a journey: `helpers/focus.ts` (WF-02 criterion 4). First the helper itself on pages of its own
 * (`page.setContent`, no stack data): a button that disables itself after moving focus passes, one that moves none
 * or is removed fails, and a late handoff passes only within the one-frame budget. Then the helper once, as a probe,
 * on the packages desk's "Log package" submit and "Hand out" confirm, on a unit the spec makes, so J4's seeded units
 * and badges are unchanged and both projects can run it at once.
 */

type Handoff = 'status' | 'none' | 'remove' | 'next-frame' | 'third-frame';

/** A Save button whose click disables (or removes) it; `handoff` says where focus goes, and when. */
async function selfDisabling(page: Page, handoff: Handoff) {
  trackRequests(page);
  await page.setContent(`
    <main>
      <button id="save" type="button">Save</button>
      <p id="status" role="status" tabindex="-1">Ready</p>
    </main>
    <script>
      {
      const save = document.getElementById('save');
      const status = document.getElementById('status');
      const later = (frames, run) => (frames === 0 ? run() : requestAnimationFrame(() => later(frames - 1, run)));
      save.addEventListener('click', () => {
        const handoff = ${JSON.stringify(handoff)};
        if (handoff === 'status') status.focus();
        if (handoff === 'remove') return save.remove();
        save.disabled = true;
        status.textContent = 'Saving';
        if (handoff === 'next-frame') later(1, () => status.focus());
        if (handoff === 'third-frame') later(3, () => status.focus());
      });
      }
    </script>
  `);
  const save = page.getByRole('button', { name: 'Save' });
  await save.focus();
  return save;
}

test.describe('the helper on pages of its own', () => {
  test('a button that moves focus to a status region, then disables itself, passes', async ({ page }) => {
    const save = await selfDisabling(page, 'status');
    await expectFocusKept(page, () => save.click(), { control: save, within: page.getByRole('main') });
    await expect(page.getByRole('status')).toBeFocused();
  });

  test('the same button with no handoff fails', async ({ page }) => {
    const save = await selfDisabling(page, 'none');
    await expect(expectFocusKept(page, () => save.click(), { control: save })).rejects.toThrow(/focus is lost at the end/);
  });

  test('a button removed with no handoff fails', async ({ page }) => {
    const save = await selfDisabling(page, 'remove');
    await expect(expectFocusKept(page, () => save.click(), { control: save })).rejects.toThrow(
      /focus is lost at the end: on <body>/,
    );
  });

  test('a handoff one frame late is within the budget', async ({ page }) => {
    const save = await selfDisabling(page, 'next-frame');
    await expectFocusKept(page, () => save.click(), { control: save });
  });

  test('a handoff three frames late is not', async ({ page }) => {
    const save = await selfDisabling(page, 'third-frame');
    await expect(expectFocusKept(page, () => save.click(), { control: save })).rejects.toThrow(
      /focus was lost for [2-9] frames in a row .*the budget is 1/,
    );
  });

  test('focus that leaves `within` fails, and so does a control that was never focused', async ({ page }) => {
    const save = await selfDisabling(page, 'status');
    const outside = page.getByRole('button', { name: 'Save' });
    await expect(
      expectFocusKept(page, () => save.click(), { control: outside, within: page.getByRole('status') }),
    ).rejects.toThrow(/before the action, focus must be inside `within`/);
    await page.getByRole('status').focus();
    await expect(expectFocusKept(page, () => save.click(), { control: save })).rejects.toThrow(
      /before the action, focus must be on the control/,
    );
  });

  test('focus moving between two same-named controls is still a change, so the page is not settled', async ({ page }) => {
    // Review round 1 (Codex, Medium): frames were compared by description, so focus alternating between two "Edit"
    // buttons counted as stable and the helper returned before their removal dropped focus.
    trackRequests(page);
    await page.setContent(`<main><button id="save">Save</button><button id="one">Edit</button><button id="two">Edit</button></main>`);
    const save = page.getByRole('button', { name: 'Save' });
    await save.focus();
    const alternate = () =>
      page.evaluate(() => {
        const one = document.getElementById('one')!;
        const two = document.getElementById('two')!;
        const until = Date.now() + 1500;
        let next = one;
        const tick = () => {
          if (Date.now() >= until) {
            one.remove();
            two.remove();
            return;
          }
          next.focus();
          next = next === one ? two : one;
          requestAnimationFrame(tick);
        };
        tick();
      });
    await expect(expectFocusKept(page, alternate, { control: save })).rejects.toThrow(/focus is lost at the end: on <body>/);
  });

  test('a request already in flight when the helper starts must finish before it passes', async ({ page }) => {
    // Review round 2 (Codex, Medium): the helper counted only requests started after it, so a refresh already out
    // was invisible: it passed, and the refresh's answer then removed the focused button.
    trackRequests(page);
    await page.route('https://focus.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<button id="save">Save</button>' }));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let arrived!: () => void;
    const requested = new Promise<void>((resolve) => (arrived = resolve));
    await page.route('https://focus.test/refresh', async (route) => {
      arrived();
      await released;
      await route.fulfill({ contentType: 'text/plain', body: 'refreshed' });
    });
    await page.goto('https://focus.test/');
    await page.evaluate(() => void fetch('/refresh').then(() => document.getElementById('save')!.remove()));
    await requested;
    const save = page.getByRole('button', { name: 'Save' });
    await save.focus();
    let outcome = 'pending';
    const checked = expectFocusKept(page, () => save.click(), { control: save }).then(
      () => (outcome = 'passed'),
      (error: Error) => (outcome = error.message),
    );
    // Well past the helper's 300 ms of quiet, counted in the page's frames (no sleep), with the refresh still out.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const until = performance.now() + 1500;
          const tick = () => (performance.now() >= until ? resolve() : requestAnimationFrame(tick));
          tick();
        }),
    );
    expect(outcome, 'the helper returned while the refresh was out').toBe('pending');
    release();
    await checked;
    expect(outcome).toMatch(/focus is lost at the end: on <body>/);
  });

  test('a page whose requests are not tracked is refused', async ({ page }) => {
    await page.setContent('<button>Save</button>');
    const save = page.getByRole('button', { name: 'Save' });
    await save.focus();
    await expect(expectFocusKept(page, () => save.click(), { control: save })).rejects.toThrow(/call trackRequests\(page\)/);
  });

  // A page whose clock is not the runner's (`page.clock`, a date-sensitive view) still gets 300 ms of its own time
  // (WF-02a review round 1, Codex: page and runner timestamps were subtracted from each other).
  test('a page clock a day ahead of the runner still waits 300 ms of page time', async ({ page }) => {
    await page.clock.install({ time: new Date(Date.now() + 86_400_000) });
    trackRequests(page);
    await page.setContent('<button>Save</button>');
    const save = page.getByRole('button', { name: 'Save' });
    await save.focus();
    const started = await page.evaluate(() => performance.now());
    await expectFocusKept(page, async () => {}, { control: save });
    const elapsed = (await page.evaluate(() => performance.now())) - started;
    expect(elapsed, 'the helper must see 300 ms of unchanged focus').toBeGreaterThanOrEqual(300);
  });

  test('a page clock a day ahead of the runner cannot hide a drop 225 ms after the action', async ({ page }) => {
    await page.clock.install({ time: new Date(Date.now() + 86_400_000) });
    trackRequests(page);
    await page.setContent('<button>Save</button>');
    const save = page.getByRole('button', { name: 'Save' });
    await save.focus();
    const removeAfter225ms = () =>
      page.evaluate(() => {
        const until = performance.now() + 225;
        const tick = () => (performance.now() >= until ? document.querySelector('button')!.remove() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });
    await expect(expectFocusKept(page, removeAfter225ms, { control: save })).rejects.toThrow(/focus is lost at the end/);
  });

  test('a paused page clock never counts as settled', async ({ page }) => {
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 86_400_000));
    trackRequests(page);
    await page.setContent('<button>Save</button>');
    const save = page.getByRole('button', { name: 'Save' });
    await save.focus();
    await expect(expectFocusKept(page, async () => {}, { control: save })).rejects.toThrow(/never settled/);
  });
});

/**
 * Holds the page's next `method` request whose path ends with `suffix` until `release()`: on a local stack the
 * answer comes within a frame, so a control disabled while it is out would never be seen losing focus.
 */
async function hold(page: Page, method: string, suffix: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let seen!: () => void;
  const arrived = new Promise<void>((resolve) => (seen = resolve));
  await page.route(
    (url) => url.pathname.endsWith(suffix),
    async (route) => {
      if (route.request().method() !== method) return route.fallback();
      seen();
      await released;
      await route.fallback();
    },
  );
  return { arrived, release };
}

/** Three animation frames of the page: longer than the helper's one-frame budget. */
const threeFrames = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

/** Letters and digits unique to this run, for a unit of the spec's own. */
const unique = (length: number) => randomBytes(length).toString('hex').toUpperCase().slice(0, length);

test.describe('probe: the packages desk', () => {
  test('"Log package" keeps focus while the create is out', async ({ newContext, baseURL }) => {
    const manager = await newContext({ storageState: storageStatePath('mapleManager') });
    const maple = await buildingId(manager.request, 'maple');
    const unit = { tower: `F${unique(5)}`, label: unique(6) };
    await createUnit(manager.request, baseURL!, maple, unit);
    const name = `${unit.tower}-${unit.label}`;

    const desk = await (await newContext({ storageState: storageStatePath('mapleSecurity') })).newPage();
    trackRequests(desk);
    await desk.goto('/security/packages');
    const panel = desk.getByRole('region', { name: 'Log package' });
    await panel.getByLabel('Unit', { exact: true }).fill(unit.label);
    await panel.getByRole('radio', { name, exact: true }).check();
    await panel.getByRole('radio', { name: 'Other', exact: true }).check();
    await panel.getByLabel('Other carrier').fill(`E2E ${unique(8)}`);
    const submit = panel.getByRole('button', { name: 'Log package' });
    await submit.focus();
    const create = await hold(desk, 'POST', `/api/buildings/${maple}/packages`);

    await expectFocusKept(
      desk,
      async () => {
        await submit.click();
        await create.arrived;
        await threeFrames(desk);
        create.release();
      },
      { control: submit },
    );
    await expect(panel.getByLabel('Unit', { exact: true })).toBeFocused();
  });

  test('"Hand out" keeps focus through the dialog closing', async ({ newContext, baseURL }) => {
    const manager = await newContext({ storageState: storageStatePath('mapleManager') });
    const maple = await buildingId(manager.request, 'maple');
    const unit = { tower: `F${unique(5)}`, label: unique(6) };
    const unitId = await createUnit(manager.request, baseURL!, maple, unit);
    const name = `${unit.tower}-${unit.label}`;
    const deskContext = await newContext({ storageState: storageStatePath('mapleSecurity') });
    const item = await logPackage(deskContext.request, baseURL!, maple, { unit_id: unitId, carrier: `E2E ${unique(8)}` });

    const desk = await deskContext.newPage();
    trackRequests(desk);
    await desk.goto('/security/packages');
    await desk.getByLabel('Unit number', { exact: true }).fill(unit.label);
    await desk.getByRole('group', { name: 'Show packages for' }).getByRole('radio', { name, exact: true }).check();
    await desk.getByRole('button', { name: `Hand out the ${item.carrier} package for unit ${name}` }).click();
    const dialog = desk.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'Someone else' }).check();
    await dialog.getByLabel('Their name').fill('Focus probe');
    const confirm = dialog.getByRole('button', { name: 'Hand out', exact: true });
    await confirm.focus();
    const pickup = await hold(desk, 'POST', `/packages/${item.id}/pickup`);

    await expectFocusKept(
      desk,
      async () => {
        await confirm.click();
        await pickup.arrived;
        await threeFrames(desk);
        pickup.release();
      },
      { control: confirm },
    );
    await expect(desk.getByTestId('package-message')).toBeFocused();
  });
});
