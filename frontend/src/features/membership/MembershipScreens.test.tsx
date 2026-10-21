// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { parseJoinCode } from '@/features/onboarding/JoinCodeForm';
import { BIRCH, MAPLE, RESIDENT_ME, calls, json, membership, problem, renderApp, stubApi } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type Schemas = components['schemas'];

const ME = 'GET /api/auth/me';
const status = (building: { id: string }) => `GET /api/buildings/${building.id}/onboarding/me`;
const meWith = (...memberships: Schemas['MeMembershipOut'][]): Schemas['MeOut'] => ({ ...RESIDENT_ME, memberships });
const mine = (overrides: Partial<Schemas['OnboardingMeOut']>): Schemas['OnboardingMeOut'] => ({
  status: 'pending',
  unit_label: '1003',
  tower: null,
  relationship: 'tenant',
  decision_reason: null,
  ...overrides,
});
const location = () => screen.getByTestId('location').textContent;

describe('pending screen', () => {
  it('shows the unit and relationship submitted, from onboarding/me (1)', async () => {
    stubApi({ [ME]: () => json(meWith(membership(MAPLE, { status: 'pending' }))), [status(MAPLE)]: () => json(mine({ tower: 'A' })) });
    renderApp(['/']);
    const pending = await screen.findByTestId('pending-request');
    await waitFor(() => expect(within(pending).getByTestId('pending-unit').textContent).toContain('Unit A-1003'));
    expect(pending.textContent).toContain('Maple Tower');
    expect(pending.textContent).toContain('Tenant');
    expect(pending.textContent).toContain('The building manager will review your request.');
  });

  it('still names the building and the wait when onboarding/me fails', async () => {
    stubApi({ [ME]: () => json(meWith(membership(MAPLE, { status: 'pending' }))), [status(MAPLE)]: () => problem(500, 'internal') });
    renderApp(['/']);
    const pending = await screen.findByTestId('pending-request');
    await waitFor(() => expect(pending.textContent).toContain('The building manager will review your request.'));
    expect(pending.textContent).toContain('Maple Tower');
    expect(within(pending).queryByTestId('pending-unit')).toBeNull();
  });

  it('lists each pending building with its own request', async () => {
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: 'pending' }), membership(BIRCH, { status: 'pending' }))),
      [status(MAPLE)]: () => json(mine({ unit_label: '1003' })),
      [status(BIRCH)]: () => json(mine({ unit_label: '204', relationship: 'owner' })),
    });
    renderApp(['/']);
    await waitFor(() => expect(screen.getAllByTestId('pending-unit')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('pending-request');
    // Sorted by building name, as the picker is.
    expect(first.textContent).toContain('Birch Court');
    expect(first.textContent).toContain('Unit 204');
    expect(first.textContent).toContain('Owner');
    expect(second.textContent).toContain('Maple Tower');
  });

  it('lands on the home once a reload finds the membership approved (2)', async () => {
    let approved = false;
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: approved ? 'active' : 'pending' }))),
      [status(MAPLE)]: () => json(mine({})),
    });
    renderApp(['/']);
    await screen.findByTestId('pending-request');
    cleanup();

    approved = true;
    renderApp(['/']);
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeTruthy();
    expect(screen.queryByTestId('pending-request')).toBeNull();
  });
});

describe('denied screen', () => {
  it("shows the manager's reason, and Submit again opens the unit picker (3)", async () => {
    const reason = "Unit number doesn't match our records";
    const fetchMock = stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: 'denied' }))),
      [status(MAPLE)]: () => json(mine({ status: 'denied', decision_reason: reason })),
      'GET /api/join/MAPLE-2026': () => json({ building_id: MAPLE.id, building_name: 'Maple Tower' }),
      'GET /api/join/MAPLE-2026/units': () => json([]),
    });
    renderApp(['/']);
    const denied = await screen.findByTestId('denied-request');
    await waitFor(() => expect(within(denied).getByTestId('denied-reason').textContent).toContain(reason));
    expect(denied.textContent).toContain('Maple Tower');

    fireEvent.change(screen.getByLabelText('Join code or link'), { target: { value: 'MAPLE-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit again' }));
    await screen.findByTestId('join-request');
    expect(location()).toBe('/join/MAPLE-2026');
    expect(screen.queryByTestId('join-signup-form')).toBeNull();
    expect(calls(fetchMock)).not.toContain('POST /api/auth/signup');
  });

  it('says no reason was given when there is none', async () => {
    stubApi({
      [ME]: () => json(meWith(membership(MAPLE, { status: 'denied' }))),
      [status(MAPLE)]: () => json(mine({ status: 'denied', unit_label: null, relationship: null })),
    });
    renderApp(['/']);
    expect(await screen.findByText('No reason was given.')).toBeTruthy();
  });
});

describe('no-membership screen', () => {
  it('takes a join link and opens it (P2-06b carry)', async () => {
    stubApi({
      [ME]: () => json(meWith()),
      'GET /api/join/MAPLE-2026': () => json({ building_id: MAPLE.id, building_name: 'Maple Tower' }),
      'GET /api/join/MAPLE-2026/units': () => json([]),
    });
    renderApp(['/']);
    fireEvent.change(await screen.findByLabelText('Join code or link'), {
      target: { value: 'https://condo.example/join/MAPLE-2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('join-request');
  });

  it('refuses an empty or malformed value and stays (17)', async () => {
    stubApi({ [ME]: () => json(meWith()) });
    renderApp(['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter the join code or link your building gave you.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Join code or link'), { target: { value: 'MAPLE 2026!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Join code or link').getAttribute('aria-invalid')).toBe('true');
    expect(location()).toBe('/');
  });
});

describe('parseJoinCode (17)', () => {
  it.each([
    ['MAPLE-2026', 'MAPLE-2026'],
    [' maple-2026 ', 'MAPLE-2026'],
    ['https://condo.example/join/MAPLE-2026', 'MAPLE-2026'],
    ['condo.example/join/maple-2026?x=1#y', 'MAPLE-2026'],
    ['/join/MAPLE-2026/', 'MAPLE-2026'],
  ])('reads %j as %s', (input, code) => {
    expect(parseJoinCode(input)).toBe(code);
  });

  it.each(['', '   ', 'MAPLE 2026', 'MAPLE_2026', 'A'.repeat(17), 'https://condo.example/invite/abc', 'https://condo.example/join/'])(
    'refuses %j',
    (input) => {
      expect(parseJoinCode(input)).toBeNull();
    },
  );
});
