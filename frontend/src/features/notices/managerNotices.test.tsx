// @vitest-environment jsdom
/**
 * P6-02c: the manager's notices page at `/manage/notices`, its three lists and the publish and archive dialogs. Each
 * `describe` names the criteria it proves (docs/tickets/P6-02c-manager-notice-list-and-actions.md).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { writeSelectedBuilding } from '@/app/buildingStorage';
import { BIRCH, MAPLE, RESIDENT_ME, buildingOut, calls, json, membership, openAccountMenu, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';
import { notice, noticesBase, type Notice } from '@/test/notices';

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
type Feature = components['schemas']['Feature'];

const BASE = noticesBase();
const PAGE = '/manage/notices';
const PAST = '2020-01-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';
const CURSOR = 'c'.repeat(22);

/** Every status, newest written first, as the API orders them. */
const EVERY = (): Notice[] => [
  notice(6, { title: 'Draft B', status: 'draft', published_at: null, published_by_membership_id: null }),
  notice(5, { title: 'Live', priority: 'urgent' }),
  notice(4, { title: 'Gone stale', expires_at: PAST }),
  notice(3, { title: 'Old', status: 'archived', archived_at: '2026-10-21T10:00:00Z' }),
  notice(2, { title: 'Draft A', status: 'draft', published_at: null, published_by_membership_id: null, expires_at: FUTURE }),
  notice(1, { title: 'Later', expires_at: FUTURE }),
];

/**
 * The manager's notices API over `state`: the list by `status` (or the feed's `live=true`), the summary, and publish
 * and archive with the server's rules (409 `invalid_transition`, 422 `notice_expired`).
 */
function noticesApi(state: { notices: Notice[] }, base = BASE): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    [`GET ${base}`]: (request) => {
      const query = new URL(request.url).searchParams;
      const status = query.get('status');
      let items = state.notices;
      if (status) items = items.filter((item) => item.status === status);
      if (query.get('live') === 'true') items = items.filter((item) => item.status === 'published' && !(item.expires_at && item.expires_at <= new Date().toISOString()));
      return json({ items, next_cursor: null });
    },
    [`GET ${base}/summary`]: () => json({ unread: 0, urgent_unread: 0 }),
  };
  for (const item of EVERY()) {
    const change = (fields: Partial<Notice>) => {
      state.notices = state.notices.map((other) => (other.id === item.id ? { ...other, ...fields } : other));
      return json(state.notices.find((other) => other.id === item.id));
    };
    const now = () => state.notices.find((other) => other.id === item.id)!;
    routes[`POST ${base}/${item.id}/publish`] = () => {
      if (now().status !== 'draft') return problem(409, 'invalid_transition');
      if (now().expires_at && now().expires_at! <= new Date().toISOString()) return problem(422, 'notice_expired');
      return change({ status: 'published', published_at: '2026-10-25T10:00:00Z' });
    };
    routes[`POST ${base}/${item.id}/archive`] = () =>
      now().status === 'archived' ? problem(409, 'invalid_transition') : change({ status: 'archived', archived_at: '2026-10-25T10:00:00Z' });
  }
  return routes;
}

function manager(state: { notices: Notice[] }, overrides: Record<string, Handler> = {}, roles: Role[] = ['property_management'], features?: Feature[]) {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles, features)),
    ...noticesApi(state),
    ...overrides,
  };
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const list = (name: string) => screen.findByRole('list', { name });
const titles = async (name: string) =>
  within(await list(name))
    .getAllByRole('listitem')
    .map((row) => within(row).getByRole('heading', { level: 3 }).textContent);
const row = async (name: string, title: string) =>
  within(await list(name)).getAllByRole('listitem').find((item) => within(item).getByRole('heading', { level: 3 }).textContent === title)!;
const show = async (name: 'Drafts' | 'Published' | 'Archived') => fireEvent.click(await screen.findByRole('button', { name }));
const dialog = () => screen.findByRole('dialog');
const confirm = async (name: 'Publish' | 'Archive') => fireEvent.click(within(await dialog()).getByRole('button', { name }));
const message = () => screen.queryByTestId('notice-message');
const actionCalls = (fetchMock: ReturnType<typeof stubApi>, action: string) => calls(fetchMock).filter((call) => call.startsWith('POST') && call.endsWith(`/${action}`));
const listCalls = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call === `GET ${BASE}`);

describe('the three lists (criterion 1)', () => {
  it('shows each status’s notices in the API’s order, 25 a page, and labels an expired one', async () => {
    const fetchMock = stubApi(manager({ notices: EVERY() }));
    renderApp([PAGE]);

    expect(await screen.findByRole('heading', { name: 'Manage notices', level: 1 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Drafts' }).getAttribute('aria-pressed')).toBe('true');
    expect(await titles('Drafts')).toEqual(['Draft B', 'Draft A']);

    await show('Published');
    expect(screen.getByRole('button', { name: 'Published' }).getAttribute('aria-pressed')).toBe('true');
    expect(await titles('Published')).toEqual(['Live', 'Gone stale', 'Later']);
    expect(within(await row('Published', 'Gone stale')).getByText('Expired')).toBeTruthy();
    expect(within(await row('Published', 'Later')).queryByText('Expired')).toBeNull();
    expect(within(await row('Published', 'Live')).getByText('Urgent')).toBeTruthy();

    await show('Archived');
    expect(await titles('Archived')).toEqual(['Old']);

    const asked = fetchMock.mock.calls.map(([request]) => new URL(request.url)).filter((url) => url.pathname === BASE);
    expect(asked.map((url) => [url.searchParams.get('status'), url.searchParams.get('limit'), url.searchParams.get('live')])).toEqual([
      ['draft', '25', null],
      ['published', '25', null],
      ['archived', '25', null],
    ]);
  });

  it('shows the body through NoticeBody, drafts included, and each row’s actions', async () => {
    stubApi(manager({ notices: [notice(1, { status: 'draft', body: 'Water off **Tuesday**.\n\n<b>raw</b>' }), ...EVERY().slice(1)] }));
    renderApp([PAGE]);

    const draft = await row('Drafts', 'Notice 1');
    expect(within(draft).getByText('Tuesday').tagName).toBe('STRONG');
    expect(draft.querySelector('b')).toBeNull();
    expect(within(draft).getByRole('button', { name: 'Publish: Notice 1' })).toBeTruthy();
    expect(within(draft).getByRole('button', { name: 'Archive: Notice 1' })).toBeTruthy();

    await show('Published');
    const stale = await row('Published', 'Gone stale');
    expect(within(stale).queryByRole('button', { name: /^Publish/ })).toBeNull();
    expect(within(stale).getByRole('button', { name: 'Archive: Gone stale' })).toBeTruthy();

    await show('Archived');
    expect(within(await row('Archived', 'Old')).queryByRole('button')).toBeNull();
  });

  it('P6-02e criterion 1: focus moves to the first new row once the last page has landed', async () => {
    const more = notice(9, { title: 'Older draft', status: 'draft' });
    stubApi(
      manager(
        { notices: [] },
        {
          [`GET ${BASE}`]: (request) =>
            new URL(request.url).searchParams.get('cursor') === CURSOR
              ? json({ items: [more], next_cursor: null })
              : json({ items: [notice(8, { status: 'draft' })], next_cursor: CURSOR }),
        },
      ),
    );
    renderApp([PAGE]);

    await list('Drafts');
    const button = screen.getByRole('button', { name: 'Load more' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole('list', { name: 'Drafts' })).getAllByRole('listitem')[1]));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('loads more with the cursor, and says when a list is empty or fails', async () => {
    const more = notice(9, { title: 'Older draft', status: 'draft' });
    stubApi(
      manager(
        { notices: [] },
        {
          [`GET ${BASE}`]: (request) => {
            const query = new URL(request.url).searchParams;
            if (query.get('status') === 'archived') return problem(500, 'internal_error');
            if (query.get('status') === 'published') return json({ items: [], next_cursor: null });
            return query.get('cursor') === CURSOR ? json({ items: [more], next_cursor: null }) : json({ items: [notice(8, { status: 'draft' })], next_cursor: CURSOR });
          },
        },
      ),
    );
    renderApp([PAGE]);

    await list('Drafts');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(async () => expect(await titles('Drafts')).toEqual(['Notice 8', 'Older draft']));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    await show('Published');
    expect(await screen.findByText('No published notices.')).toBeTruthy();
    await show('Archived');
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load the notices.');
  });
});

describe('publish (criterion 2)', () => {
  it('sends one request for two clicks, moves the draft to Published, and refreshes the feed and the badge', async () => {
    const state = { notices: EVERY() };
    const fetchMock = stubApi(manager(state));
    const app = renderApp(['/notices']);
    await screen.findByRole('list', { name: 'Notices' });
    act(() => app.navigate()(PAGE));

    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' }));
    expect(within(await dialog()).getByText('Draft A')).toBeTruthy();
    const summaries = calls(fetchMock).filter((call) => call === `GET ${BASE}/summary`).length;
    const button = within(await dialog()).getByRole('button', { name: 'Publish' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(actionCalls(fetchMock, 'publish')).toEqual([`POST ${BASE}/${notice(2).id}/publish`]);
    expect(message()?.textContent).toBe('“Draft A” was published.');
    await waitFor(async () => expect(await titles('Drafts')).toEqual(['Draft B']));
    await show('Published');
    expect(await titles('Published')).toEqual(['Live', 'Gone stale', 'Draft A', 'Later']);
    // The nav's polled badge is asked again, and the feed's cache is stale for its next mount.
    await waitFor(() => expect(calls(fetchMock).filter((call) => call === `GET ${BASE}/summary`).length).toBeGreaterThan(summaries));
    expect(app.queryClient.getQueryState(['b', MAPLE.id, 'notices', 'feed'])?.isInvalidated).toBe(true);
  });

  it.each([
    ['422 notice_expired', () => problem(422, 'notice_expired'), 'This notice’s expiry has passed. Change it before publishing.'],
    ['409 invalid_transition', () => problem(409, 'invalid_transition'), 'This notice is no longer a draft: it was published or archived elsewhere.'],
    ['a server error', () => problem(500, 'internal_error'), 'Could not publish the notice. Try again.'],
    ['a rate limit', () => problem(429, 'rate_limited', { 'Retry-After': '30' }), /Too many/],
  ])('shows %s as a message and stays open, the alert focused', async (_, answer, text) => {
    const fetchMock = stubApi(manager({ notices: EVERY() }, { [`POST ${BASE}/${notice(2).id}/publish`]: answer }));
    renderApp([PAGE]);

    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' }));
    const before = listCalls(fetchMock).length;
    await confirm('Publish');

    const alert = await within(await dialog()).findByRole('alert');
    expect(alert.textContent).toMatch(text);
    expect(document.activeElement).toBe(alert);
    expect(within(await dialog()).getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(false);
    // Whatever the answer, the lists are asked again.
    await waitFor(() => expect(listCalls(fetchMock).length).toBeGreaterThan(before));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('an expired draft, by the server, answers 422', async () => {
    stubApi(manager({ notices: [notice(1, { status: 'draft', title: 'Late', expires_at: PAST })] }));
    renderApp([PAGE]);
    fireEvent.click(within(await row('Drafts', 'Late')).getByRole('button', { name: 'Publish: Late' }));
    await confirm('Publish');
    expect((await within(await dialog()).findByRole('alert')).textContent).toBe('This notice’s expiry has passed. Change it before publishing.');
  });
});

describe('archive (criterion 3)', () => {
  it.each([
    ['Drafts', 'Draft B', notice(6).id],
    ['Published', 'Gone stale', notice(4).id],
  ] as const)('moves a notice from %s to Archived', async (from, title, id) => {
    const fetchMock = stubApi(manager({ notices: EVERY() }));
    renderApp([PAGE]);
    if (from === 'Published') await show('Published');

    fireEvent.click(within(await row(from, title)).getByRole('button', { name: `Archive: ${title}` }));
    await confirm('Archive');

    await waitFor(() => expect(message()?.textContent).toBe(`“${title}” was archived.`));
    expect(actionCalls(fetchMock, 'archive')).toEqual([`POST ${BASE}/${id}/archive`]);
    await waitFor(async () => expect(await titles(from)).not.toContain(title));
    await show('Archived');
    expect(await titles('Archived')).toContain(title);
  });

  it('archiving one already archived in another tab shows the 409 message', async () => {
    const state = { notices: EVERY() };
    stubApi(manager(state));
    renderApp([PAGE]);

    fireEvent.click(within(await row('Drafts', 'Draft B')).getByRole('button', { name: 'Archive: Draft B' }));
    state.notices = state.notices.map((item) => (item.title === 'Draft B' ? { ...item, status: 'archived' } : item));
    await confirm('Archive');

    expect((await within(await dialog()).findByRole('alert')).textContent).toBe('This notice was already archived elsewhere.');
  });
});

describe('two managers publish the same draft (criterion 4, tenant row 10)', () => {
  it('the second sees the 409, and its lists end as the first’s', async () => {
    const state = { notices: EVERY() };
    stubApi(manager(state));
    renderApp([PAGE]);

    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' }));
    // The other manager's publish lands first.
    state.notices = state.notices.map((item) => (item.title === 'Draft A' ? { ...item, status: 'published' } : item));
    await confirm('Publish');

    expect((await within(await dialog()).findByRole('alert')).textContent).toBe('This notice is no longer a draft: it was published or archived elsewhere.');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(async () => expect(await titles('Drafts')).toEqual(['Draft B']));
    await show('Published');
    expect(await titles('Published')).toEqual(['Live', 'Gone stale', 'Draft A', 'Later']);
  });
});

describe('access (criterion 5, tenant rows 1, 2, 4)', () => {
  it('property management opens the page, in the nav as "Manage notices"', async () => {
    stubApi(manager({ notices: EVERY() }));
    renderApp([PAGE]);
    await list('Drafts');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Manage notices' }).getAttribute('href')).toBe(PAGE);
  });

  it.each<Role[]>([['resident'], ['security'], ['council']])('%s gets /403 without asking the notices list, and no nav item', async (role) => {
    const fetchMock = stubApi(manager({ notices: EVERY() }, {}, [role]));
    const app = renderApp([PAGE]);
    await waitFor(() => expect(app.location().pathname).toBe('/403'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: /Manage notices|Daily notices/ })).toBeNull();
    await settle();
    expect(listCalls(fetchMock)).toEqual([]);
  });

  it('a signed-out user goes to login with the way back', async () => {
    const fetchMock = stubApi({ 'GET /api/auth/me': () => problem(401, 'not_authenticated') });
    const app = renderApp([PAGE]);
    await waitFor(() => expect(app.location().pathname).toBe('/login'));
    expect(app.location().search).toContain(encodeURIComponent(PAGE));
    expect(calls(fetchMock).some((call) => call.includes('/notices'))).toBe(false);
  });

  it('a building with notices off gives /403 without asking the notices list', async () => {
    const fetchMock = stubApi(manager({ notices: EVERY() }, {}, ['property_management'], ['packages', 'maintenance']));
    const app = renderApp([PAGE]);
    await waitFor(() => expect(app.location().pathname).toBe('/403'));
    await settle();
    expect(listCalls(fetchMock)).toEqual([]);
  });
});

describe('focus after a dialog (criterion 6)', () => {
  it('Cancel and Escape return focus to the opener', async () => {
    stubApi(manager({ notices: EVERY() }));
    renderApp([PAGE]);
    const opener = within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' });

    fireEvent.click(opener);
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));

    fireEvent.click(opener);
    fireEvent.keyDown(await dialog(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('Escape does nothing while the request is out', async () => {
    let release: (() => void) | undefined;
    stubApi(
      manager({ notices: EVERY() }, { [`POST ${BASE}/${notice(2).id}/publish`]: () => new Promise<Response>((resolve) => (release = () => resolve(json(notice(2))))) }),
    );
    renderApp([PAGE]);
    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' }));
    await confirm('Publish');
    fireEvent.keyDown(await dialog(), { key: 'Escape' });
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    // The disabled button would drop focus to <body>; the dialog holds it.
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    release!();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('after a success, focus is on the outcome message', async () => {
    stubApi(manager({ notices: EVERY() }));
    renderApp([PAGE]);
    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Archive: Draft A' }));
    await confirm('Archive');
    await waitFor(() => expect(document.activeElement).toBe(message()));
  });

  it('if a refresh took the opener away, focus goes to the list’s heading', async () => {
    const state = { notices: EVERY() };
    stubApi(manager(state));
    const app = renderApp([PAGE]);
    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' }));
    state.notices = state.notices.filter((item) => item.title !== 'Draft A');
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'notices'] }));
    await waitFor(async () => expect(await titles('Drafts')).toEqual(['Draft B']));

    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Drafts', level: 2 })));
  });
});

describe('a refresh that removes the focused row (review round 1, Codex F1)', () => {
  it('a 409’s late refresh after Cancel moves focus from the restored opener to the list’s heading', async () => {
    let asked = 0;
    let release: ((response: Response) => void) | undefined;
    stubApi(
      manager(
        { notices: [] },
        {
          [`GET ${BASE}`]: () =>
            ++asked === 1 ? json({ items: [notice(2, { status: 'draft', title: 'Draft A' })], next_cursor: null }) : new Promise<Response>((resolve) => (release = resolve)),
          [`POST ${BASE}/${notice(2).id}/publish`]: () => problem(409, 'invalid_transition'),
        },
      ),
    );
    renderApp([PAGE]);
    const opener = within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' });
    fireEvent.click(opener);
    await confirm('Publish');
    await within(await dialog()).findByRole('alert');
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));

    act(() => release!(json({ items: [], next_cursor: null })));
    await screen.findByText('No drafts.');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Drafts', level: 2 }));
  });

  it('a refetch with no dialog open that removes the row whose button has focus does the same', async () => {
    const state = { notices: EVERY() };
    stubApi(manager(state));
    const app = renderApp([PAGE]);
    within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Archive: Draft A' }).focus();

    state.notices = state.notices.filter((item) => item.title !== 'Draft A');
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'notices'] }));
    await waitFor(async () => expect(await titles('Drafts')).toEqual(['Draft B']));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Drafts', level: 2 }));
  });

  it('a refetch that removes another row leaves focus where it is', async () => {
    const state = { notices: EVERY() };
    stubApi(manager(state));
    const app = renderApp([PAGE]);
    const kept = within(await row('Drafts', 'Draft B')).getByRole('button', { name: 'Archive: Draft B' });
    kept.focus();

    state.notices = state.notices.filter((item) => item.title !== 'Draft A');
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['b', MAPLE.id, 'notices'] }));
    await waitFor(async () => expect(await titles('Drafts')).toEqual(['Draft B']));
    expect(document.activeElement).toBe(kept);
  });
});

describe('the legacy page (criterion 7)', () => {
  it('/ManagementNotices goes to /manage/notices with its query and hash', async () => {
    stubApi(manager({ notices: EVERY() }));
    const app = renderApp(['/ManagementNotices?from=mail#top']);
    await list('Drafts');
    expect(app.location().pathname).toBe(PAGE);
    expect(app.location().search).toBe('?from=mail');
    expect(app.location().hash).toBe('#top');
  });
});

describe('switching building (criterion 8)', () => {
  it('shows only the new building’s notices, and closes an open dialog', async () => {
    const birch = noticesBase(BIRCH.id);
    stubApi({
      'GET /api/auth/me': () =>
        json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['property_management'] }), membership(BIRCH, { roles: ['property_management'] })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      ...noticesApi({ notices: EVERY() }),
      [`GET ${birch}`]: () => new Promise<Response>(() => {}),
      [`GET ${birch}/summary`]: () => json({ unread: 0, urgent_unread: 0 }),
    });
    writeSelectedBuilding(MAPLE.id);
    const app = renderApp([PAGE]);
    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' }));
    await dialog();

    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => app.navigate()(PAGE));

    expect(await screen.findByText('Loading notices…')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Draft A' })).toBeNull();
  });
});

describe('the selected building only (criterion 11, tenant row 3)', () => {
  it('asks only the selected building’s notices URLs', async () => {
    const fetchMock = stubApi(manager({ notices: EVERY() }));
    renderApp([PAGE]);
    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: 'Publish: Draft A' }));
    await confirm('Publish');
    await waitFor(() => expect(message()).not.toBeNull());
    const notices = calls(fetchMock).filter((call) => call.includes('/notices'));
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((call) => call.includes(`/api/buildings/${MAPLE.id}/notices`))).toBe(true);
  });

  it.each(['Publish', 'Archive'] as const)('building_not_found on %s marks the building denied', async (name) => {
    const action = name === 'Publish' ? 'publish' : 'archive';
    stubApi(manager({ notices: EVERY() }, { [`POST ${BASE}/${notice(2).id}/${action}`]: () => problem(404, 'building_not_found') }));
    const app = renderApp([PAGE]);
    fireEvent.click(within(await row('Drafts', 'Draft A')).getByRole('button', { name: `${name}: Draft A` }));
    await confirm(name);
    await waitFor(() => expect(app.queryClient.getQueryData(['b', MAPLE.id, 'denied'])).toEqual(expect.any(Number)));
  });
});

describe('P6-02e review round 1 F1 neighbour: a row whose focused child went earlier', () => {
  it('does not take focus from another row when it is removed later', async () => {
    const state = { notices: [notice(2, { title: 'Draft B', status: 'draft' }), notice(1, { title: 'Draft A', status: 'draft', body: 'See [the plan](https://example.test/plan).' })] };
    stubApi(manager(state));
    const app = renderApp([PAGE]);
    const card = await row('Drafts', 'Draft A');
    const link = within(card).getByRole('link', { name: 'the plan' });
    link.focus();

    // Another manager edits the body: the refresh removes only the focused link.
    state.notices = state.notices.map((item) => (item.id === notice(1).id ? { ...item, body: 'No link now.' } : item));
    await act(async () => {
      await app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'notices'] });
    });
    await waitFor(() => expect(link.isConnected).toBe(false));
    expect(card.isConnected).toBe(true);

    const elsewhere = within(await row('Drafts', 'Draft B')).getByRole('button', { name: 'Edit: Draft B' });
    elsewhere.focus();
    state.notices = state.notices.filter((item) => item.id !== notice(1).id);
    await act(async () => {
      await app.queryClient.refetchQueries({ queryKey: ['b', MAPLE.id, 'notices'] });
    });
    await waitFor(() => expect(card.isConnected).toBe(false));
    expect(document.activeElement).toBe(elsewhere);
  });
});
