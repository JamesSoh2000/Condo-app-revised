// @vitest-environment jsdom
/**
 * WF-02 criterion 4's finding: "Log package" disables its submit while the create is out and moved focus only after a
 * 201, so in a browser focus fell to <body> for the wait, and stayed there after a refusal (`e2e/tests/focus.spec.ts`
 * found it in Chromium). `expectFocusKept` reads what a browser would; the create is held until the test answers.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { expectFocusKept } from '@/test/focus';
import { MAPLE, RESIDENT_ME, buildingOut, json, membership, problem, renderApp, stubApi } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

const base = `/api/buildings/${MAPLE.id}`;
const U101: components['schemas']['UnitOut'] = {
  id: '01929a4e-0000-7000-8000-0000000c0001',
  tower: 'A',
  label: '101',
  floor: 1,
  is_active: true,
  current_occupant_count: 0,
};
const CREATED: components['schemas']['PackageOut'] = {
  id: '01929a4e-0000-7000-8000-0000000e0001',
  unit_id: U101.id,
  recipient_membership_id: null,
  carrier: 'UPS',
  description: null,
  tracking_last4: null,
  photo_file_id: null,
  status: 'received',
  received_at: new Date().toISOString(),
  received_by_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
  picked_up_at: null,
  returned_at: null,
  unit_tower: 'A',
  unit_label: '101',
  recipient_name: null,
};

/** The desk, with the create held until `answer` is called with its response. */
function desk() {
  let answer!: (response: Response) => void;
  const answered = new Promise<Response>((resolve) => (answer = resolve));
  stubApi({
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['security'] })] }),
    [`GET ${base}`]: () => json(buildingOut(MAPLE, ['security'])),
    [`GET ${base}/packages`]: () => json({ items: [], next_cursor: null }),
    [`GET ${base}/units`]: () => json({ items: [U101], next_cursor: null }),
    [`GET ${base}/units/${U101.id}/occupants`]: () => json([]),
    [`POST ${base}/packages`]: () => answered,
  });
  return answer;
}

const form = () => screen.getByRole('form', { name: 'Log package' });
const submit = () => within(form()).getByRole('button', { name: 'Log package' });

async function filled() {
  renderApp(['/security/packages']);
  fireEvent.click(await within(await screen.findByRole('form', { name: 'Log package' })).findByRole('radio', { name: /^A-101$/ }));
  fireEvent.click(within(form()).getByRole('radio', { name: 'UPS' }));
  submit().focus();
}

afterEach(cleanup);

describe('"Log package" keeps focus in the form while the create is out', () => {
  it('then the unit search has it after a 201', async () => {
    const answer = desk();
    await filled();
    await expectFocusKept(
      () => {
        fireEvent.click(submit());
      },
      {
        control: submit,
        within: form,
        settle: async () => {
          answer(json(CREATED, 201));
          await within(form()).findByText('Logged ✓');
        },
      },
    );
  });

  it('and after a refusal', async () => {
    const answer = desk();
    await filled();
    await expectFocusKept(
      () => {
        fireEvent.click(submit());
      },
      {
        control: submit,
        within: form,
        settle: async () => {
          answer(problem(500, 'internal_error'));
          await within(form()).findByText('Could not log the package. Your details are kept; try again.');
        },
      },
    );
  });
});
