import { expect, type Request, test } from '@playwright/test';

import { apiLogin, apiSignup, NEW_PASSWORD, uniqueEmail } from '../helpers/auth';
import { extractLink, waitForEmail } from '../helpers/mailpit';

const RESET_PASSWORD = 'E2e-Reset-Password-2026!';
/** What a signed-in account with no building sees (MembershipScreens). */
const NO_BUILDING = 'You are not a member of a building yet';

test('J7: a password reset by email signs out another logged-in context', async ({ page, browser, baseURL }) => {
  const email = uniqueEmail('j7-reset');
  // The journey's own account, so its new password affects no other journey.
  const signup = await browser.newContext();
  await apiSignup(signup.request, baseURL!, email, 'Rowan Reset');
  await signup.close();

  // A second device, signed in.
  const other = await browser.newContext();
  await apiLogin(other.request, baseURL!, email, NEW_PASSWORD);
  const otherPage = await other.newPage();
  await otherPage.goto('/');
  await expect(otherPage.getByRole('heading', { name: NO_BUILDING })).toBeVisible();

  await page.goto('/login');
  await page.getByTestId('login-forgot-link').click();
  await page.getByLabel('Email').fill(email);
  await page.getByTestId('forgot-submit').click();
  await expect(page.getByTestId('forgot-status')).toBeVisible();

  const resetEmail = await waitForEmail(email, 'Reset your password');
  await page.goto(extractLink(resetEmail, '/reset-password/'));
  await page.getByLabel('New password', { exact: true }).fill(RESET_PASSWORD);
  await page.getByLabel('Confirm new password').fill(RESET_PASSWORD);
  await page.getByTestId('reset-submit').click();
  await expect(page).toHaveURL('/login');

  // The new password works.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(RESET_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: NO_BUILDING })).toBeVisible();

  // The other device's session ended with the reset: its next navigation ends on the login page.
  await otherPage.goto('/');
  await expect(otherPage).toHaveURL(/\/login/);
  await expect(otherPage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect((await other.request.get('/api/auth/me')).status()).toBe(401);
  await other.close();
});

test('J7 Web Lock: a slow logout in one page and a login in another stay ordered, and the login wins', async ({
  browser,
  baseURL,
}) => {
  // Two pages of one context share the cookie jar and the `condo.auth` Web Lock (P2-06c D4).
  const context = await browser.newContext();
  const pageB = await context.newPage();
  // Opened before the session exists: a signed-in visit to /login would leave it.
  await pageB.goto('/login');
  await expect(pageB.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const email = uniqueEmail('j7-lock');
  await apiSignup(context.request, baseURL!, email, 'Lee Lock');
  const pageA = await context.newPage();
  await pageA.goto('/');
  await expect(pageA.getByRole('heading', { name: NO_BUILDING })).toBeVisible();

  // The order the auth calls reach the network, and the logout's answer.
  const order: string[] = [];
  context.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/login' || path === '/api/auth/logout') order.push(`request ${path}`);
  });
  context.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/auth/logout') order.push('response /api/auth/logout');
  });

  // Page A's logout is held at the network until page B's login is waiting for the lock.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const logoutHeld = new Promise<void>((resolve) => (held = resolve));
  await pageA.route('**/api/auth/logout', async (route) => {
    held();
    await released;
    await route.continue();
  });
  await pageA.getByRole('button', { name: /Account menu/ }).click();
  await pageA.getByRole('button', { name: 'Log out' }).click();
  await logoutHeld;

  await pageB.getByLabel('Email').fill(email);
  await pageB.getByLabel('Password').fill(NEW_PASSWORD);
  await pageB.getByRole('button', { name: 'Sign in' }).click();
  // B's login queues behind A's logout, which holds the lock.
  await expect
    .poll(() => pageB.evaluate(async () => (await navigator.locks.query()).pending?.map((lock) => lock.name)))
    .toContain('condo.auth');
  release();

  await expect(pageB.getByRole('heading', { name: NO_BUILDING })).toBeVisible();
  // The login went out only after the logout answered, so the logout's cleared cookie can't undo it.
  expect(order).toEqual(['request /api/auth/logout', 'response /api/auth/logout', 'request /api/auth/login']);
  await pageB.reload();
  await expect(pageB.getByRole('heading', { name: NO_BUILDING })).toBeVisible();
  expect((await context.request.get('/api/auth/me')).status()).toBe(200);
  await context.close();
});
