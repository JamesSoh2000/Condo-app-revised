import { expect, test } from '../helpers/test';

import { NEW_PASSWORD, storageStatePath, uniqueEmail } from '../helpers/auth';
import { extractLink, waitForEmail } from '../helpers/mailpit';

test('J2: a manager invites security, who accepts by email and lands on security home', async ({
  newContext,
  page,
}) => {
  const securityEmail = uniqueEmail('j2-security');

  // The manager invites through the Invitations tab (P4-08g criterion 12).
  const manager = await newContext({ storageState: storageStatePath('mapleManager') });
  const managerPage = await manager.newPage();
  await managerPage.goto('/manage/residents?tab=invitations');
  await managerPage.getByLabel('Email').fill(securityEmail);
  await managerPage.getByRole('group', { name: 'Roles' }).getByRole('checkbox', { name: 'Security' }).check();
  await managerPage.getByRole('button', { name: 'Send invitation' }).click();
  await expect(managerPage.getByRole('status').filter({ hasText: `Invitation sent to ${securityEmail}.` })).toBeFocused();
  const row = managerPage.getByRole('list', { name: 'Pending invitations' }).getByRole('listitem').filter({ hasText: securityEmail });
  await expect(row).toContainText('Security');
  await manager.close();

  const email = await waitForEmail(securityEmail, "You're invited to join Maple Tower");
  await page.goto(extractLink(email, '/invite/'));
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await page.getByLabel('Full name').fill('Sasha Guard');
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm password').fill(NEW_PASSWORD);
  await page.getByTestId('invite-submit').click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Maple Tower')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Package log' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Residents' })).toHaveCount(0);

  // The account menu opens from the keyboard with Enter and with Space (carried from P2-06c).
  const menuButton = page.getByRole('button', { name: /Account menu/ });
  const panel = page.getByText(`Signed in as ${securityEmail}`);
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(menuButton).toBeFocused();
  await page.keyboard.press('Space');
  await expect(panel).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
});
