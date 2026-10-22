import { test as base } from '@playwright/test';

import { resetRateLimits } from './cli';

export { expect, type Browser, type Page, type Request } from '@playwright/test';

/**
 * The journeys' `test`: before a retry (CI's `retries: 1`), the rate-limit windows are emptied, so the retry can't be
 * refused for the first attempt's requests (P4-09 review round 1, F2). A first attempt runs within the per-run
 * budget in README.md.
 */
export const test = base.extend<{ freshRateLimitsOnRetry: void }>({
  freshRateLimitsOnRetry: [
    async ({}, use, testInfo) => {
      if (testInfo.retry > 0) await resetRateLimits();
      await use();
    },
    { auto: true },
  ],
});
