// @vitest-environment jsdom
/**
 * P6-02d: the notice editor on `/manage/notices`: a new draft and an existing one, preview, expiry in building time,
 * and publish (the expiry and the attachment are P6-02f's). Each `describe` names the criteria it proves (docs/tickets/P6-02d-notice-editor.md).
 * `fetch` is stubbed; the browser at 375 px is in the PR's Chromium transcript.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { components } from '@/api/schema';
import { writeSelectedBuilding } from '@/app/buildingStorage';
import { NoticeBody } from '@/features/notices/NoticeBody';
import { BIRCH, MAPLE, RESIDENT_ME, buildingOut, calls, json, membership, openAccountMenu, problem, renderApp, stubApi, type Handler } from '@/test/renderApp';
import { notice, noticesBase, type Notice } from '@/test/notices';
import { render } from '@testing-library/react';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, ...actual.createApiClient({ baseUrl: 'http://app.test' }) };
});

type Role = components['schemas']['Role'];

const BASE = noticesBase();
const PAGE = '/manage/notices';
const FILE_OLD = '01929a4e-0000-7000-8000-0000000fa0ff';
const NEW_ID = '01929a4e-0000-7000-8000-0000000f0099';

const draft = (n: number, fields: Partial<Notice> = {}) =>
  notice(n, { status: 'draft', published_at: null, published_by_membership_id: null, ...fields });

interface Server {
  notices: Notice[];
  /** Every create and update body, in order, with its method and path. */
  sent: { method: string; path: string; body: Record<string, unknown> }[];
}

/** The manager's notices API over `server`: lists by status, create, update and publish. */
function noticesApi(server: Server): Record<string, Handler> {
  const record = async (request: Request) => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    server.sent.push({ method: request.method, path: new URL(request.url).pathname, body });
    return body;
  };
  const routes: Record<string, Handler> = {
    [`GET ${BASE}`]: (request) => {
      const status = new URL(request.url).searchParams.get('status');
      return json({ items: server.notices.filter((item) => !status || item.status === status), next_cursor: null });
    },
    [`GET ${BASE}/summary`]: () => json({ unread: 0, urgent_unread: 0 }),
    [`POST ${BASE}`]: async (request) => {
      const body = await record(request);
      const created = draft(99, {
        id: NEW_ID,
        title: body.title as string,
        body: body.body as string,
        priority: (body.priority as Notice['priority']) ?? 'normal',
        expires_at: (body.expires_at as string | undefined) ?? null,
        attachment_file_id: (body.attachment_file_id as string | undefined) ?? null,
        attachment_content_type: body.attachment_file_id ? 'application/pdf' : null,
      });
      server.notices = [created, ...server.notices];
      return json(created, 201);
    },
  };
  for (const id of [NEW_ID, ...server.notices.map((item) => item.id)]) {
    routes[`PATCH ${BASE}/${id}`] = async (request) => {
      const body = await record(request);
      const now = server.notices.find((item) => item.id === id)!;
      if (now.status !== 'draft') return problem(409, 'notice_not_editable');
      const changed: Notice = { ...now, ...body };
      server.notices = server.notices.map((item) => (item.id === id ? changed : item));
      return json(changed);
    };
    routes[`POST ${BASE}/${id}/publish`] = () => {
      const now = server.notices.find((item) => item.id === id)!;
      if (now.status !== 'draft') return problem(409, 'invalid_transition');
      server.notices = server.notices.map((item) => (item.id === id ? { ...item, status: 'published', published_at: '2026-10-25T13:00:00Z' } : item));
      return json(server.notices.find((item) => item.id === id));
    };
  }
  return routes;
}

function manager(server: Server, overrides: Record<string, Handler> = {}, roles: Role[] = ['property_management']) {
  return stubApi({
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles)),
    ...noticesApi(server),
    ...overrides,
  });
}

const serverWith = (...notices: Notice[]): Server => ({ notices, sent: [] });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
const editor = () => screen.findByRole('dialog');
const inEditor = () => within(screen.getByRole('dialog'));
const type = (label: string | RegExp, value: string) => fireEvent.change(inEditor().getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(inEditor().getByRole('button', { name: 'Save draft' }));
const writes = (fetchMock: ReturnType<typeof stubApi>) => calls(fetchMock).filter((call) => call.startsWith('POST') || call.startsWith('PATCH'));
const rowOf = async (title: string) =>
  within(await screen.findByRole('list', { name: 'Drafts' }))
    .getAllByRole('listitem')
    .find((item) => within(item).getByRole('heading', { level: 3 }).textContent === title)!;

async function openNew() {
  fireEvent.click(await screen.findByRole('button', { name: 'New notice' }));
  await editor();
}
async function openEdit(title: string) {
  fireEvent.click(within(await rowOf(title)).getByRole('button', { name: `Edit: ${title}` }));
  await editor();
}
async function saved() {
  await waitFor(() => expect(inEditor().getByTestId('editor-status').textContent).toBe('Draft saved.'));
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('a new draft (criterion 1)', () => {
  it('sends one create with title, body and priority, keeps the editor on the saved draft and lists it in Drafts', async () => {
    const server = serverWith(draft(1));
    const fetchMock = manager(server);
    renderApp([PAGE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Published' }));
    await openNew();
    expect(screen.getByRole('heading', { name: 'New notice' })).toBeTruthy();
    expect(document.activeElement).toBe(inEditor().getByLabelText('Title'));

    type('Title', '  Water shut-off  ');
    type('Body (Markdown)', '\n Tuesday **9–11**.\n');
    fireEvent.click(inEditor().getByRole('radio', { name: 'Urgent' }));
    save();
    await saved();

    expect(server.sent).toEqual([{ method: 'POST', path: BASE, body: { title: 'Water shut-off', body: 'Tuesday **9–11**.', priority: 'urgent' } }]);
    expect(writes(fetchMock)).toEqual([`POST ${BASE}`]);
    expect(screen.getByRole('heading', { name: 'Edit notice' })).toBeTruthy();
    expect(document.activeElement).toBe(inEditor().getByTestId('editor-status'));
    expect(screen.getByRole('button', { name: 'Drafts' }).getAttribute('aria-pressed')).toBe('true');
    expect(await rowOf('Water shut-off')).toBeTruthy();
  });

  it('a second save of the new draft updates it, not a second create', async () => {
    const server = serverWith();
    const fetchMock = manager(server);
    renderApp([PAGE]);
    await openNew();
    type('Title', 'One');
    type('Body (Markdown)', 'Text');
    save();
    await saved();
    type('Title', 'Two');
    save();
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent[1]).toEqual({ method: 'PATCH', path: `${BASE}/${NEW_ID}`, body: { title: 'Two' } });
    expect(writes(fetchMock)).toEqual([`POST ${BASE}`, `PATCH ${BASE}/${NEW_ID}`]);
  });
});

describe('an existing draft (criterion 2)', () => {
  const existing = () => draft(1, { title: 'Pool', body: 'Closed.', expires_at: '2999-07-15T22:00:00Z', attachment_file_id: FILE_OLD, attachment_content_type: 'application/pdf' });

  it('opens with the saved values', async () => {
    manager(serverWith(existing()));
    renderApp([PAGE]);
    await openEdit('Pool');
    expect(inEditor().getByLabelText<HTMLInputElement>('Title').value).toBe('Pool');
    expect(inEditor().getByLabelText<HTMLTextAreaElement>('Body (Markdown)').value).toBe('Closed.');
    expect(inEditor().getByRole<HTMLInputElement>('radio', { name: 'Normal' }).checked).toBe(true);
  });

  it('a body change sends only body, and keeps the draft’s expiry and attachment (P6-02f edits them)', async () => {
    const server = serverWith(existing());
    manager(server);
    renderApp([PAGE]);
    await openEdit('Pool');
    type('Body (Markdown)', 'Closed until Friday.');
    save();
    await saved();
    expect(server.sent).toEqual([{ method: 'PATCH', path: `${BASE}/${existing().id}`, body: { body: 'Closed until Friday.' } }]);
    expect(server.notices[0]).toMatchObject({ expires_at: '2999-07-15T22:00:00Z', attachment_file_id: FILE_OLD });
  });

  it('a change undone, or only spaces added around the text, sends nothing and says so', async () => {
    const server = serverWith(existing());
    const fetchMock = manager(server);
    renderApp([PAGE]);
    await openEdit('Pool');
    type('Title', 'Gym');
    type('Title', '  Pool ');
    type('Body (Markdown)', 'Closed.\n');
    save();
    expect(await inEditor().findByText('No changes to save.')).toBeTruthy();
    await settle();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('only draft rows have Edit', async () => {
    manager(serverWith(existing(), notice(2, { title: 'Live' })));
    renderApp([PAGE]);
    expect(within(await rowOf('Pool')).getByRole('button', { name: 'Edit: Pool' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Published' }));
    const live = await screen.findByRole('list', { name: 'Published' });
    expect(within(live).queryByRole('button', { name: /^Edit/ })).toBeNull();
  });
});

describe('preview (criterion 3)', () => {
  it('renders the stripped body through NoticeBody, as the feed does, with no raw HTML', async () => {
    manager(serverWith());
    renderApp([PAGE]);
    await openNew();
    type('Title', 'Fire drill');
    // Indented by four spaces, the unstripped text would be a code block; the server stores it stripped.
    const text = '    Drill at **noon**.\n\n<img src=x onerror=alert(1)><b>raw</b>\n\n[go](javascript:alert(1))';
    type('Body (Markdown)', text);
    fireEvent.click(inEditor().getByRole('radio', { name: 'Urgent' }));
    fireEvent.click(inEditor().getByRole('button', { name: 'Preview' }));

    const preview = inEditor().getByTestId('notice-preview');
    expect(within(preview).getByRole('heading', { name: 'Fire drill' })).toBeTruthy();
    expect(within(preview).getByText('Urgent')).toBeTruthy();
    expect(within(preview).getByText('noon').tagName).toBe('STRONG');
    expect(preview.querySelector('pre, code, img, b, a[href]')).toBeNull();

    const feed = render(<NoticeBody markdown={text.trim()} />).container.firstElementChild!;
    expect(preview.querySelector('.notice-body')!.outerHTML).toBe(feed.outerHTML);
    cleanup();
  });

  it('Write goes back to the text, kept as typed', async () => {
    manager(serverWith());
    renderApp([PAGE]);
    await openNew();
    type('Body (Markdown)', 'Hello');
    fireEvent.click(inEditor().getByRole('button', { name: 'Preview' }));
    expect(inEditor().getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true');
    expect(inEditor().queryByLabelText('Body (Markdown)')).toBeNull();
    fireEvent.click(inEditor().getByRole('button', { name: 'Write' }));
    expect(inEditor().getByLabelText<HTMLTextAreaElement>('Body (Markdown)').value).toBe('Hello');
  });
});

describe('the schema’s limits before sending (criterion 6)', () => {
  const tooLong = (field: 'Title' | 'Body (Markdown)', value: string, message: string) => [field, value, message] as const;
  it.each([
    tooLong('Title', 'x'.repeat(201), 'Use at most 200 characters.'),
    tooLong('Body (Markdown)', 'x'.repeat(10_001), 'Use at most 10 000 characters.'),
    tooLong('Body (Markdown)', 'a\u0000b', 'Use visible characters, tabs and line breaks only.'),
    tooLong('Title', 'a\tb', 'Use visible characters only.'),
    tooLong('Title', 'a\ud800b', 'Use visible characters only.'),
    tooLong('Body (Markdown)', 'a\udc00b', 'Use visible characters, tabs and line breaks only.'),
    tooLong('Title', ' 　  ', 'Enter a title.'),
    tooLong('Body (Markdown)', '\n\n', 'Enter the notice text.'),
  ])('%s %#: refused with no request', async (field, value, message) => {
    const fetchMock = manager(serverWith());
    renderApp([PAGE]);
    await openNew();
    type('Title', 'Fine');
    type('Body (Markdown)', 'Fine');
    type(field, value);
    save();
    const input = inEditor().getByLabelText(field);
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe(message);
    expect(document.activeElement).toBe(input);
    await settle();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('counts code points as Python does, and strips Python’s whitespace only', async () => {
    const server = serverWith();
    manager(server);
    renderApp([PAGE]);
    await openNew();
    // 200 emoji are 400 UTF-16 units; U+FEFF isn't whitespace to Python, so it is kept and counted.
    type('Title', '😀'.repeat(199) + '﻿');
    type('Body (Markdown)', 'B');
    save();
    await saved();
    expect(server.sent[0].body.title).toBe('😀'.repeat(199) + '﻿');
  });

  it('places the API’s own 422 field errors on their fields, and an unplaceable one on the form', async () => {
    const errors = (loc: string[], type: string) => json({ type: 'about:blank', title: 'Unprocessable', status: 422, code: 'validation_error', errors: [{ loc, type, msg: 'x' }] }, 422);
    const answers = [errors(['body', 'title'], 'string_too_long'), errors(['body', 'body'], 'control_characters'), errors(['body'], 'value_error')];
    manager(serverWith(), { [`POST ${BASE}`]: () => answers.shift()! });
    renderApp([PAGE]);
    await openNew();
    type('Title', 'T');
    type('Body (Markdown)', 'B');
    const described = (label: string) => document.getElementById(inEditor().getByLabelText(label).getAttribute('aria-describedby')!)?.textContent;
    save();
    await waitFor(() => expect(described('Title')).toBe('Use at most 200 characters.'));
    expect(document.activeElement).toBe(inEditor().getByLabelText('Title'));
    save();
    await waitFor(() => expect(described('Body (Markdown)')).toBe('Use visible characters, tabs and line breaks only.'));
    save();
    expect(await inEditor().findByText('Check the details and try again.')).toBeTruthy();
  });
});

describe('a refused field while Preview is shown (criterion 6, review round 1 F1)', () => {
  const refuse = (field: string, type: string) =>
    json({ type: 'about:blank', title: 'Unprocessable', status: 422, code: 'validation_error', errors: [{ loc: ['body', field], type, msg: 'x' }] }, 422);
  async function fromPreview(answer?: Handler) {
    const server = serverWith();
    manager(server, answer ? { [`POST ${BASE}`]: answer } : {});
    renderApp([PAGE]);
    await openNew();
    type('Title', 'Pool');
    type('Body (Markdown)', 'Closed.');
    fireEvent.click(inEditor().getByRole('button', { name: 'Preview' }));
    return server;
  }

  it('a server error on body goes back to Write and focuses the body', async () => {
    await fromPreview(() => refuse('body', 'control_characters'));
    save();
    await waitFor(() => expect(document.activeElement).toBe(inEditor().getByLabelText('Body (Markdown)')));
    expect(inEditor().getByRole('button', { name: 'Write' }).getAttribute('aria-pressed')).toBe('true');
    expect(inEditor().getByText('Use visible characters, tabs and line breaks only.')).toBeTruthy();
  });

  it('a server error on title focuses the title and leaves the preview shown', async () => {
    await fromPreview(() => refuse('title', 'string_too_long'));
    save();
    await waitFor(() => expect(document.activeElement).toBe(inEditor().getByLabelText('Title')));
    expect(inEditor().getByTestId('notice-preview')).toBeTruthy();
  });

  it('an error that fits no field focuses the form message and leaves the preview shown', async () => {
    await fromPreview(() => refuse('nothing', 'value_error'));
    save();
    await waitFor(() => expect(document.activeElement).toBe(inEditor().getByRole('alert')));
    expect(inEditor().getByTestId('notice-preview')).toBeTruthy();
  });

  it('a client refusal of the body goes back to Write and focuses it, with no request', async () => {
    const server = await fromPreview();
    fireEvent.click(inEditor().getByRole('button', { name: 'Write' }));
    type('Body (Markdown)', 'x'.repeat(10_001));
    fireEvent.click(inEditor().getByRole('button', { name: 'Preview' }));
    save();
    await waitFor(() => expect(document.activeElement).toBe(inEditor().getByLabelText('Body (Markdown)')));
    await settle();
    expect(server.sent).toEqual([]);
  });
});

describe('published elsewhere meanwhile (criterion 7)', () => {
  it('409 notice_not_editable: the message shows, every field keeps its value, and Publish isn’t offered', async () => {
    const server = serverWith(draft(1, { title: 'Pool', body: 'Closed.' }));
    manager(server);
    renderApp([PAGE]);
    await openEdit('Pool');
    server.notices = server.notices.map((item) => ({ ...item, status: 'published' }));
    type('Title', 'Pool and gym');
    type('Body (Markdown)', 'Both closed.');
    fireEvent.click(inEditor().getByRole('radio', { name: 'Urgent' }));
    save();
    expect((await inEditor().findByRole('alert')).textContent).toBe('This notice is no longer a draft: it was published or archived elsewhere. Your text is kept here to copy.');
    expect(inEditor().getByLabelText<HTMLInputElement>('Title').value).toBe('Pool and gym');
    expect(inEditor().getByLabelText<HTMLTextAreaElement>('Body (Markdown)').value).toBe('Both closed.');
    expect(inEditor().getByRole<HTMLInputElement>('radio', { name: 'Urgent' }).checked).toBe(true);
    expect(inEditor().queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(inEditor().queryByRole('button', { name: 'Save draft' })).toBeNull();
  });
});

describe('access (criterion 8)', () => {
  it.each([['resident'], ['security'], ['council']] as const)('a %s gets /403 on the page, so no entry point', async (role) => {
    manager(serverWith(draft(1)), {}, [role]);
    const app = renderApp([PAGE]);
    await waitFor(() => expect(app.location().pathname).toBe('/403'));
    expect(screen.queryByRole('button', { name: 'New notice' })).toBeNull();
  });
});

describe('one request per press (case 11)', () => {
  it('a double click on Save sends one create, and Save is refused while it is out', async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = manager(serverWith(), { [`POST ${BASE}`]: () => new Promise<Response>((resolve) => (answer = resolve)) });
    renderApp([PAGE]);
    await openNew();
    type('Title', 'T');
    type('Body (Markdown)', 'B');
    const button = inEditor().getByRole('button', { name: 'Save draft' });
    // In one act, so the second press comes before `disabled` renders, as a fast double click can.
    act(() => {
      button.click();
      button.click();
    });
    await settle();
    expect(writes(fetchMock)).toEqual([`POST ${BASE}`]);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    answer(json(draft(99, { id: NEW_ID, title: 'T', body: 'B' }), 201));
    await saved();
  });
});

describe('unsaved work (case 12)', () => {
  it('Escape keeps an editor with unsaved changes open; Cancel closes it and focus goes back to New notice', async () => {
    manager(serverWith());
    renderApp([PAGE]);
    await openNew();
    type('Title', 'Half written');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(inEditor().getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New notice' }));
  });

  it('a priority chosen on an empty new notice counts as unsaved; set back to Normal, it doesn’t (review round 1 F2)', async () => {
    manager(serverWith());
    renderApp([PAGE]);
    await openNew();
    fireEvent.click(inEditor().getByRole('radio', { name: 'Urgent' }));
    expect(inEditor().getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(inEditor().getByRole<HTMLInputElement>('radio', { name: 'Urgent' }).checked).toBe(true);
    fireEvent.click(inEditor().getByRole('radio', { name: 'Normal' }));
    expect(inEditor().getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Escape doesn’t close while a save is out, even with nothing else unsaved', async () => {
    let answer: (response: Response) => void = () => {};
    manager(serverWith(draft(1, { title: 'Pool', body: 'Closed.' })), {
      [`PATCH ${BASE}/${draft(1).id}`]: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    renderApp([PAGE]);
    await openEdit('Pool');
    type('Body (Markdown)', 'Open.');
    save();
    await settle();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    answer(json(draft(1, { title: 'Pool', body: 'Open.' })));
    await saved();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Escape closes an editor with nothing unsaved', async () => {
    manager(serverWith(draft(1, { title: 'Pool' })));
    renderApp([PAGE]);
    await openEdit('Pool');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(within(await rowOf('Pool')).getByRole('button', { name: 'Edit: Pool' }));
  });
});

describe('switching building (case 13)', () => {
  it('removes the open editor and sends nothing to either building', async () => {
    const birch = noticesBase(BIRCH.id);
    const fetchMock = stubApi({
      'GET /api/auth/me': () =>
        json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['property_management'] }), membership(BIRCH, { roles: ['property_management'] })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      ...noticesApi(serverWith()),
      [`GET ${birch}`]: () => json({ items: [], next_cursor: null }),
      [`GET ${birch}/summary`]: () => json({ unread: 0, urgent_unread: 0 }),
    });
    writeSelectedBuilding(MAPLE.id);
    const app = renderApp([PAGE]);
    await openNew();
    type('Title', 'For Maple');
    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => app.navigate()(PAGE));
    await screen.findByText('No drafts.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(fetchMock).filter((call) => call.includes('/notices'))).toEqual([]);
  });
});

describe('switching building with a save out (case 13, review round 1 neighbour)', () => {
  it('removes the editor; the late answer changes nothing in the new building and sends nothing more', async () => {
    const birch = noticesBase(BIRCH.id);
    let answer: (response: Response) => void = () => {};
    const fetchMock = stubApi({
      'GET /api/auth/me': () =>
        json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles: ['property_management'] }), membership(BIRCH, { roles: ['property_management'] })] }),
      [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}`]: () => json(buildingOut(BIRCH, ['property_management'])),
      [`GET /api/buildings/${BIRCH.id}/notifications/summary`]: () => json({ unread_count: 0 }),
      ...noticesApi(serverWith()),
      [`POST ${BASE}`]: () => new Promise<Response>((resolve) => (answer = resolve)),
      [`GET ${birch}`]: () => json({ items: [], next_cursor: null }),
      [`GET ${birch}/summary`]: () => json({ unread: 0, urgent_unread: 0 }),
    });
    writeSelectedBuilding(MAPLE.id);
    const app = renderApp([PAGE]);
    await openNew();
    type('Title', 'For Maple');
    type('Body (Markdown)', 'Text');
    save();
    await settle();
    openAccountMenu();
    fireEvent.change(screen.getByRole('combobox', { name: 'Building' }), { target: { value: BIRCH.id } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => app.navigate()(PAGE));
    await screen.findByText('No drafts.');
    answer(json(draft(99, { id: NEW_ID, title: 'For Maple', body: 'Text' }), 201));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('For Maple')).toBeNull();
    expect(screen.getByText('No drafts.')).toBeTruthy();
    expect(writes(fetchMock).filter((call) => call.includes('/notices'))).toEqual([`POST ${BASE}`]);
  });
});

describe('publish from the editor (case 14)', () => {
  it('is offered only on a saved draft with nothing unsaved, and opens the confirm dialog that publishes it', async () => {
    const server = serverWith();
    manager(server);
    renderApp([PAGE]);
    await openNew();
    expect(inEditor().queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(inEditor().getByText('Save your changes to publish.')).toBeTruthy();
    type('Title', 'Elevator');
    type('Body (Markdown)', 'Out of service.');
    save();
    await saved();
    type('Title', 'Elevator 2');
    expect(inEditor().queryByRole('button', { name: 'Publish' })).toBeNull();
    type('Title', 'Elevator');

    fireEvent.click(inEditor().getByRole('button', { name: 'Publish' }));
    const confirm = await screen.findByRole('dialog', { name: 'Publish this notice?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Publish' }));
    expect((await screen.findByTestId('notice-message')).textContent).toBe('“Elevator” was published.');
    expect(server.notices[0].status).toBe('published');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
