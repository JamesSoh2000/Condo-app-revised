import { randomUUID } from 'node:crypto';

import { expect, test } from '../helpers/test';

import { NEW_PASSWORD, uniqueEmail } from '../helpers/auth';
import { runCli } from '../helpers/cli';
import { extractLink, waitForEmail } from '../helpers/mailpit';

test('J1: an operator bootstraps a building and its first manager sets a password and lands home', async ({ page }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const name = `E2E Tower ${slug}`;
  const managerEmail = uniqueEmail('j1-manager');

  await runCli([
    'bootstrap-building',
    '--slug', slug,
    '--name', name,
    '--address', '1 Test Street, Toronto, ON',
    '--timezone', 'America/Toronto',
    '--manager-email', managerEmail,
    '--reason', 'P4-09 J1 journey',
  ]);

  // The link comes from the email the worker sent, as the manager would get it.
  const email = await waitForEmail(managerEmail, `You're invited to join ${name}`);
  const link = extractLink(email, '/invite/');

  await page.goto(link);
  await expect(page.getByRole('heading', { name: `Join ${name}` })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  // A new email: the invitation asks for an account first.
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Full name').fill('Jordan E2E');
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm password').fill(NEW_PASSWORD);
  await page.getByTestId('invite-submit').click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Residents' })).toBeVisible();

  // Single use: the same link, opened again, is the invalid-link screen.
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /no longer valid/ })).toBeVisible();
});
