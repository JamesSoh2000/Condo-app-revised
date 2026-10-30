// @vitest-environment jsdom
/**
 * P6-04c criteria 2 and 2a: internal comments in the request view. The server keeps them from residents
 * (`visible_maintenance_comments`, P6-03d); these prove the view shows each caller only their own answer, labels an
 * internal one, and never shows a staff thread cached in the tab to someone else.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { writeSelectedBuilding } from '@/app/buildingStorage';
import { maintenanceBase } from '@/test/maintenance';
import { REQUEST, comment, memberWorld, viewRoutes, viewState } from '@/test/maintenanceView';
import { BIRCH, MAPLE, RESIDENT_ME, buildingOut, json, membership, openAccountMenu, renderApp, stubApi, type Handler } from '@/test/renderApp';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type Role = components['schemas']['Role'];

const PUBLIC = comment('2026-10-21T12:00:00Z', { body: 'A plumber comes Friday.', author_name: 'Sam Lee' });
const INTERNAL = comment('2026-10-21T13:00:00Z', { body: 'Owner disputes the bill.', is_internal: true, author_name: 'Sam Lee' });
const STAFF_THREAD = viewState({ comments: [PUBLIC, INTERNAL] });
// What the server answers a resident: the public comment only.
const RESIDENT_THREAD = viewState({ comments: [PUBLIC] });
// A member who is a resident and the property manager in Maple: the staff role reads internal comments there.
const STAFF_ROLES: Role[] = ['resident', 'property_management'];

const ONE = `${maintenanceBase()}/${REQUEST.id}`;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const dialog = () => screen.findByRole('dialog', { name: 'Plumbing request' });
const rowOf = async (text: string) => (await within(await dialog()).findByText(text)).closest('li')!;
const never = () => new Promise<Response>(() => {});

describe('each caller sees the server’s answer (criterion 2)', () => {
  it('shows staff both comments, the internal one labelled "Internal" as text', async () => {
    stubApi(memberWorld(STAFF_THREAD, STAFF_ROLES));
    renderApp([`/maintenance/${REQUEST.id}`]);

    const internal = await rowOf('Owner disputes the bill.');
    expect(within(internal).getByText('Internal')).toBeTruthy();
    const pub = await rowOf('A plumber comes Friday.');
    expect(within(pub).queryByText('Internal')).toBeNull();
    expect(pub.textContent).toContain('Sam Lee');
  });

  it('shows a resident only the public comment, with no "Internal" anywhere', async () => {
    stubApi(memberWorld(RESIDENT_THREAD));
    renderApp([`/maintenance/${REQUEST.id}`]);

    expect(await rowOf('A plumber comes Friday.')).toBeTruthy();
    expect(within(await dialog()).queryByText('Internal')).toBeNull();
    expect(within(await dialog()).queryByText('Owner disputes the bill.')).toBeNull();
  });

  it('renders the answer as given: an internal comment the server sent is shown, labelled', async () => {
    // The view doesn't filter; it labels. (A resident never gets one: P6-03d's tests.)
    stubApi(memberWorld(STAFF_THREAD));
    renderApp([`/maintenance/${REQUEST.id}`]);

    expect(within(await rowOf('Owner disputes the bill.')).getByText('Internal')).toBeTruthy();
  });
});

describe('nothing of a staff thread cached in the tab shows to another caller (criteria 2, 2a)', () => {
  it('switching to a building where the caller is a resident shows only that building’s answer', async () => {
    const birch = `/api/buildings/${BIRCH.id}`;
    const birchRoutes = viewRoutes(RESIDENT_THREAD, BIRCH);
    stubApi({
      ...memberWorld(STAFF_THREAD, STAFF_ROLES),
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: STAFF_ROLES }), membership(BIRCH)] }),
      [`GET ${birch}`]: () => json(buildingOut(BIRCH, ['resident'])),
      [`GET ${birch}/notifications/summary`]: () => json({ unread_count: 0 }),
      ...birchRoutes,
      // Birch's thread never answers: whatever shows meanwhile came from the tab.
      [`GET ${maintenanceBase(BIRCH)}/${REQUEST.id}/comments`]: never,
    });
    writeSelectedBuilding(MAPLE.id);
    const app = renderApp([`/maintenance/${REQUEST.id}`]);
    await rowOf('Owner disputes the bill.');

    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });
    act(() => app.navigate()(`/maintenance/${REQUEST.id}`));
    await dialog();
    await settle();

    expect(screen.queryByText('Owner disputes the bill.')).toBeNull();
    expect(screen.queryByText('Internal')).toBeNull();
    expect(screen.queryByText('A plumber comes Friday.')).toBeNull();
  });

  it('a new user signing in on the tab sees nothing of the previous user’s thread', async () => {
    let me = { ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: STAFF_ROLES })] };
    let thread: Handler | null = null;
    stubApi({
      ...memberWorld(STAFF_THREAD, STAFF_ROLES),
      'GET /api/auth/me': () => json(me),
      [`GET ${ONE}/comments`]: (request) => (thread ? thread(request) : json({ items: STAFF_THREAD.comments, next_cursor: null })),
    });
    const app = renderApp([`/maintenance/${REQUEST.id}`]);
    await rowOf('Owner disputes the bill.');

    // Another tab signed in as Kim, a resident of Maple: /me now answers Kim.
    thread = never;
    me = { user: { ...RESIDENT_ME.user, id: 'kim', full_name: 'Kim Laurent' }, memberships: [membership(MAPLE)] };
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await settle();

    expect(screen.queryByText('Owner disputes the bill.')).toBeNull();
    expect(screen.queryByText('Internal')).toBeNull();
  });

  it('2a: losing the staff role (seen through /me) never shows the staff answer under the resident’s', async () => {
    let roles: Role[] = STAFF_ROLES;
    let thread: Handler | null = null;
    stubApi({
      ...memberWorld(STAFF_THREAD, STAFF_ROLES),
      'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
      [`GET ${ONE}/comments`]: (request) => (thread ? thread(request) : json({ items: STAFF_THREAD.comments, next_cursor: null })),
    });
    const app = renderApp([`/maintenance/${REQUEST.id}`]);
    await rowOf('Owner disputes the bill.');

    thread = never;
    roles = ['resident'];
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['me'] }));
    await settle();

    expect(screen.queryByText('Owner disputes the bill.')).toBeNull();
    expect(screen.queryByText('Internal')).toBeNull();
  });

  it('2a: a closed view keeps no thread: reopening it shows nothing until the new answer', async () => {
    let thread: Handler | null = null;
    stubApi({
      ...memberWorld(STAFF_THREAD, STAFF_ROLES),
      [`GET ${ONE}/comments`]: (request) => (thread ? thread(request) : json({ items: STAFF_THREAD.comments, next_cursor: null })),
    });
    const app = renderApp(['/maintenance']);
    fireEvent.click(await screen.findByRole('link', { name: /^Details: Plumbing/ }));
    await rowOf('Owner disputes the bill.');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await settle();

    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['b', MAPLE.id, 'maintenance', 'request'] })).toEqual([]);
    thread = never;
    fireEvent.click(screen.getByRole('link', { name: /^Details: Plumbing/ }));
    await dialog();
    await settle();
    expect(screen.queryByText('Owner disputes the bill.')).toBeNull();
  });
});
