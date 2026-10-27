import { expect, type Locator, type Page, type Request } from './test';

/**
 * Focus kept through an action, in real Chromium (WF-02; the CLAUDE.md focus lessons). Chromium reports the focus
 * change of a disabled or removed element late (a frame after), and may not deliver it to framework handlers (a React
 * `onBlur` on a detached node), so events are no record. Instead a `requestAnimationFrame` loop records, per frame,
 * whether focus is lost: on <body>, on an element that is disabled, inert or not rendered, or outside `within`.
 */

/** Bad frames in a row tolerated after the action: one is the browser's own fix-up; two is what a keyboard or
 *  screen-reader user notices. Fixed here: never raised to make a test pass. */
const BAD_FRAMES_ALLOWED = 1;
/** The page counts as settled when no request is in flight and nothing changed for this long. */
const STABLE_MS = 300;

interface Frame {
  at: number;
  bad: boolean;
  focused: string;
}

declare global {
  interface Window {
    __focusFrames?: Frame[];
    __focusStop?: () => void;
  }
}

export async function expectFocusKept(
  page: Page,
  action: () => Promise<void>,
  options: { control: Locator; within?: Locator },
): Promise<void> {
  await expect(options.control, 'before the action, focus must be on the control').toBeFocused();
  const region = options.within ? await options.within.elementHandle() : null;

  // A set, not a count: a request that started before these listeners ends without having been added.
  const inFlight = new Set<Request>();
  let lastNetwork = Date.now();
  const started = (request: Request) => {
    inFlight.add(request);
    lastNetwork = Date.now();
  };
  const ended = (request: Request) => {
    inFlight.delete(request);
    lastNetwork = Date.now();
  };
  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);

  try {
    const inside = await page.evaluate((within) => {
      const describe = (element: Element | null) => {
        if (!element || element === document.body) return '<body>';
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return `<${element.tagName.toLowerCase()} "${name.slice(0, 60)}">`;
      };
      const lost = (element: Element | null) =>
        !element ||
        element === document.body ||
        !element.isConnected ||
        element.matches(':disabled') ||
        element.closest('[inert]') !== null ||
        !element.checkVisibility() ||
        (within !== null && !within.contains(element));
      window.__focusFrames = [];
      let frame = 0;
      const tick = () => {
        const active = document.activeElement;
        window.__focusFrames!.push({ at: Date.now(), bad: lost(active), focused: describe(active) });
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      window.__focusStop = () => cancelAnimationFrame(frame);
      return within === null || within.contains(document.activeElement);
    }, region);
    expect(inside, 'before the action, focus must be inside `within`').toBe(true);

    const actionStarted = Date.now();
    await action();

    // Settled: no request in flight, at least two frames recorded after the action, and no change of focus or
    // network for STABLE_MS.
    await expect
      .poll(
        async () => {
          if (inFlight.size > 0) return 'a request is in flight';
          const frames = await page.evaluate(() => window.__focusFrames ?? []);
          const after = frames.filter((frame) => frame.at >= actionStarted);
          if (after.length < 2) return 'too few frames after the action';
          let changed = actionStarted;
          for (let i = 1; i < after.length; i++) {
            if (after[i].focused !== after[i - 1].focused || after[i].bad !== after[i - 1].bad) changed = after[i].at;
          }
          const quiet = after[after.length - 1].at - Math.max(changed, lastNetwork);
          return quiet >= STABLE_MS ? 'settled' : `changed ${quiet} ms ago`;
        },
        { message: 'the page never settled after the action' },
      )
      .toBe('settled');

    const frames = (await page.evaluate(() => window.__focusFrames ?? [])).filter((frame) => frame.at >= actionStarted);
    let run = 0;
    let worst = 0;
    let lastGood = 'the control';
    let lostOn = '';
    for (const frame of frames) {
      if (!frame.bad) {
        lastGood = frame.focused;
        run = 0;
        continue;
      }
      run++;
      if (run > worst) {
        worst = run;
        lostOn = frame.focused;
      }
    }
    const final = frames[frames.length - 1];
    expect(final.bad, `focus is lost at the end: on ${final.focused}; last focused: ${lastGood}`).toBe(false);
    expect(
      worst,
      `focus was lost for ${worst} frames in a row (on ${lostOn}); the budget is ${BAD_FRAMES_ALLOWED}`,
    ).toBeLessThanOrEqual(BAD_FRAMES_ALLOWED);
  } finally {
    page.off('request', started);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
    await page.evaluate(() => window.__focusStop?.()).catch(() => {});
    await region?.dispose();
  }
}
