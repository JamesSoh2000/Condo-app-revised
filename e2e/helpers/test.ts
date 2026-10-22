import { type BrowserContext, type BrowserContextOptions, type Page, test as base } from '@playwright/test';

import { resetRateLimits } from './cli';

export { expect, type Locator, type Page, type Request } from '@playwright/test';

/** The `newContext` fixture's type, for helpers that take it. */
export type NewContext = (options?: BrowserContextOptions) => Promise<BrowserContext>;

/**
 * The journeys' `test`:
 * - Before a retry (CI's `retries: 1`), the rate-limit windows are emptied, so the retry can't be refused for the
 *   first attempt's requests (P4-09 review round 1, F2). A first attempt runs within the per-run budget in README.md.
 * - `newContext(options)` opens another browser context (a second user or device) with the project's settings, as
 *   `browser.newContext` does, and also records its pages' video: kept and attached when the test fails, deleted
 *   when it passes, as the config's `video: 'retain-on-failure'` does for the `page` fixture's context, which
 *   `browser.newContext` doesn't (review round 2, R2-2). Open every extra context with it; it closes them at the end.
 */
export const test = base.extend<{
  freshRateLimitsOnRetry: void;
  newContext: NewContext;
}>({
  freshRateLimitsOnRetry: [
    async ({}, use, testInfo) => {
      if (testInfo.retry > 0) await resetRateLimits();
      await use();
    },
    { auto: true },
  ],
  newContext: async ({ browser }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({ ...options, recordVideo: { dir: testInfo.outputPath('videos') } });
      context.on('page', (page) => pages.push(page));
      contexts.push(context);
      return context;
    });
    // A video is complete once its context is closed; closing one twice is harmless.
    await Promise.all(contexts.map((context) => context.close()));
    const failed = testInfo.status !== testInfo.expectedStatus;
    for (const [index, page] of pages.entries()) {
      const video = page.video();
      if (!video) continue;
      if (failed) await testInfo.attach(`video-context-page-${index + 1}`, { path: await video.path(), contentType: 'video/webm' });
      else await video.delete();
    }
  },
});
