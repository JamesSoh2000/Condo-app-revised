import type { components } from '@/api/schema';
import { MAPLE, RESIDENT_ME, buildingOut, json, membership, noContent, problem, type Handler } from '@/test/renderApp';

/** A notices API over a mutable state, for the P6-02b tests (the feed, one notice, the banner, the summary, reads). */

export type Notice = components['schemas']['NoticeOut'];
type Role = components['schemas']['Role'];
type Feature = components['schemas']['Feature'];

export const noticesBase = (buildingId = MAPLE.id) => `/api/buildings/${buildingId}/notices`;

export function notice(n: number, fields: Partial<Notice> = {}): Notice {
  return {
    id: `01929a4e-0000-7000-8000-0000000f00${String(n).padStart(2, '0')}`,
    title: `Notice ${n}`,
    body: `Body of notice ${n}.`,
    priority: 'normal',
    status: 'published',
    expires_at: null,
    attachment_file_id: null,
    attachment_content_type: null,
    author_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    published_at: '2026-10-20T14:00:00Z',
    published_by_membership_id: '01929a4e-0000-7000-8000-0000000d0009',
    archived_at: null,
    archived_by_membership_id: null,
    created_at: '2026-10-20T13:00:00Z',
    updated_at: '2026-10-20T14:00:00Z',
    read_at: null,
    ...fields,
  };
}

export interface NoticeServer {
  /** Newest first, as the API orders them. */
  notices: Notice[];
  /** The ids the caller may see but which aren't live (a manager's drafts): `GET …/{id}` answers them. */
  hidden?: Notice[];
}

const live = (item: Notice) => item.status === 'published';
const unread = (item: Notice) => live(item) && item.read_at === null;

export function noticeSummary(state: NoticeServer) {
  const open = state.notices.filter(unread);
  return { unread: open.length, urgent_unread: open.filter((item) => item.priority === 'urgent').length };
}

/** The notices routes of `buildingId` over `state`; a read marks the notice read in `state`. */
export function noticeRoutes(state: NoticeServer, buildingId = MAPLE.id): Record<string, Handler> {
  const base = noticesBase(buildingId);
  const routes: Record<string, Handler> = {
    [`GET ${base}`]: (request) => {
      const query = new URL(request.url).searchParams;
      if (query.get('live') !== 'true') throw new Error('the notices lists ask live=true');
      let items = state.notices.filter(live);
      const priority = query.get('priority');
      if (priority) items = items.filter((item) => item.priority === priority);
      if (query.get('unread') === 'true') items = items.filter((item) => item.read_at === null);
      const limit = Number(query.get('limit') ?? 50);
      return json({ items: items.slice(0, limit), next_cursor: items.length > limit ? 'c'.repeat(22) : null });
    },
    [`GET ${base}/summary`]: () => json(noticeSummary(state)),
  };
  for (const item of [...state.notices, ...(state.hidden ?? [])]) {
    routes[`GET ${base}/${item.id}`] = () => {
      const found = [...state.notices.filter(live), ...(state.hidden ?? [])].find((other) => other.id === item.id);
      return found ? json(found) : problem(404, 'notice_not_found');
    };
    routes[`POST ${base}/${item.id}/read`] = () => {
      if (!state.notices.some((other) => other.id === item.id && live(other))) return problem(404, 'notice_not_found');
      state.notices = state.notices.map((other) =>
        other.id === item.id ? { ...other, read_at: other.read_at ?? '2026-10-22T10:00:00Z' } : other,
      );
      return noContent();
    };
  }
  return routes;
}

/** A member of Maple with `roles` (a resident by default), its building, and the notices API over `state`. */
export function noticeMember(
  state: NoticeServer,
  overrides: Record<string, Handler> = {},
  roles: Role[] = ['resident'],
  features?: Feature[],
): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => json({ ...RESIDENT_ME, memberships: [membership(MAPLE, { roles })] }),
    [`GET /api/buildings/${MAPLE.id}`]: () => json(buildingOut(MAPLE, roles, features)),
    ...noticeRoutes(state),
    ...overrides,
  };
}
