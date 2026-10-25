import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/api/errors';
import { useMe } from '@/app/AuthProvider';
import { useBuildingId } from '@/app/BuildingProvider';
import { useLoadMore } from '@/features/lists/useLoadMore';
import { relationshipLabel, unitName } from '@/features/onboarding/api';
import { MemberDialog } from '@/features/residents/MemberDialog';
import { RolesDialog } from '@/features/residents/RolesDialog';
import { TransferDialog } from '@/features/residents/TransferDialog';
import {
  ROLE_LABELS,
  membersListKey,
  useMembers,
  type Member,
  type MemberActionKind,
  type MemberFilters,
  type MemberRole,
  type MemberStatus,
} from '@/features/residents/api';

const STATUSES: Record<MemberStatus, string> = {
  active: 'Active',
  pending: 'Pending',
  suspended: 'Suspended',
  deactivated: 'Moved out',
  denied: 'Denied',
};
// Pending members are decided in "Pending requests"; denied and moved-out ones have nothing left to change here.
const ACTIONS: Record<MemberStatus, MemberActionKind[]> = {
  active: ['suspend', 'deactivate'],
  suspended: ['reactivate', 'deactivate'],
  pending: [],
  denied: [],
  deactivated: [],
};
// The roles editor and the transfer (P4-08e) come first on an active row: they change it without ending anything.
type Kind = MemberActionKind | 'roles' | 'transfer';
const LABELS: Record<Kind, { text: string; name: (member: string) => string }> = {
  roles: { text: 'Change roles', name: (member) => `Change roles of ${member}` },
  transfer: { text: 'Transfer unit', name: (member) => `Transfer ${member} to another unit` },
  suspend: { text: 'Suspend', name: (member) => `Suspend ${member}` },
  reactivate: { text: 'Reactivate', name: (member) => `Reactivate ${member}` },
  deactivate: { text: 'Move out', name: (member) => `Move out ${member}` },
};
/** The row's buttons: its status's actions, after the roles editor and, for a resident, the transfer. */
const kinds = (member: Member): Kind[] =>
  member.status === 'active'
    ? ['roles', ...(member.roles.includes('resident') ? (['transfer'] as const) : []), ...ACTIONS.active]
    : ACTIONS[member.status];
const BUTTON_STYLES: Record<Kind, string> = {
  roles: 'border border-slate-400',
  transfer: 'border border-slate-400',
  reactivate: 'bg-slate-900 text-white',
  suspend: 'border border-red-700 text-red-700',
  deactivate: 'border border-red-700 text-red-700',
};
// `MemberSearch` (backend app/memberships/schemas.py) refuses control characters.
const SEARCH_INVALID = 'Search with visible characters only.';

interface Open {
  kind: Kind;
  member: Member;
  opener: HTMLButtonElement;
}

/**
 * The "Members" tab (P4-08c): the building's members, filtered and searched, each with the actions its status
 * allows. As `PendingRequests`, the dialog keeps the member it was opened with, and the list is the server's after
 * every outcome (the mutation invalidates it).
 */
export function Members() {
  const buildingId = useBuildingId();
  const queryClient = useQueryClient();
  const myId = useMe().data?.user.id;
  const [filters, setFilters] = useState<MemberFilters>({ role: null, status: null, search: '' });
  const [searchText, setSearchText] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const members = useMembers(buildingId, filters);
  const [open, setOpen] = useState<Open | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const more = useLoadMore(members, () => headingRef.current?.focus());
  const id = useId();
  // Where focus goes once the dialog has closed: state, so the effect runs after the commit that shows the message
  // (PendingRequests). Without a message, back to the opener, or to the tab's heading if its row went, not <body>.
  const [focusTo, setFocusTo] = useState<{ target: HTMLElement | 'message' } | null>(null);
  useEffect(() => {
    if (focusTo) (focusTo.target === 'message' ? messageRef.current : focusTo.target)?.focus();
  }, [focusTo]);

  const close = (outcome: string | null) => {
    if (outcome) setMessage(outcome);
    const back = open?.opener.isConnected ? open.opener : headingRef.current;
    setFocusTo({ target: outcome || !back ? 'message' : back });
    setOpen(null);
  };

  // Each combination starts from its first page: the cached pages of an earlier visit would all be fetched again
  // (review round 1, Codex F1). The current combination is left alone, so the same search again changes nothing.
  const applyFilters = (change: Partial<MemberFilters>) => {
    const next = { ...filters, ...change };
    if (next.role === filters.role && next.status === filters.status && next.search === filters.search) return;
    queryClient.removeQueries({ queryKey: membersListKey(buildingId, next), exact: true });
    setFilters(next);
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    if (/\p{Cc}/u.test(searchText)) return setSearchError(SEARCH_INVALID);
    setSearchError(null);
    applyFilters({ search: searchText.trim() });
  };

  // A 422 can only be the search (the selects send valid values): shown on the field, not as a list error.
  const invalidSearch = members.error instanceof ApiError && members.error.status === 422;
  const searchProblem = searchError ?? (invalidSearch ? SEARCH_INVALID : null);
  const items = members.data?.pages.flatMap((page) => page.items) ?? [];

  let body;
  if (members.isPending) body = <p role="status">Loading members…</p>;
  else if (members.isError && !members.isFetchNextPageError && !invalidSearch) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {members.data ? 'Could not refresh the members.' : 'Could not load the members.'}{' '}
        <button type="button" className="underline" onClick={() => void members.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const list =
    members.data && items.length === 0 ? (
      <p>No members match.</p>
    ) : (
      members.data && (
        <ul ref={more.listRef} aria-label="Members" className="flex flex-col gap-3">
          {items.map((member) => (
            <li key={member.membership_id} tabIndex={-1} className="rounded border bg-white p-3 [overflow-wrap:anywhere]">
              <h3 className="font-medium">{member.full_name}</h3>
              <p className="text-sm text-slate-700">{member.email}</p>
              <p className="text-sm text-slate-700">
                {STATUSES[member.status]} · {member.roles.map((role) => ROLE_LABELS[role]).join(', ') || 'No roles'}
              </p>
              {member.unit_label !== null && (
                <p className="text-sm text-slate-700">
                  Unit {unitName(member.tower, member.unit_label)}
                  {member.relationship && ` · ${relationshipLabel(member.relationship)}`}
                </p>
              )}
              {member.status_reason && <p className="text-sm text-slate-700">Reason: {member.status_reason}</p>}
              {kinds(member).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {kinds(member).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      aria-label={LABELS[kind].name(member.full_name)}
                      onClick={(event) => {
                        setMessage(null);
                        setOpen({ kind, member, opener: event.currentTarget });
                      }}
                      className={`min-h-11 rounded px-4 py-2 text-sm font-medium ${BUTTON_STYLES[kind]}`}
                    >
                      {LABELS[kind].text}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )
    );

  return (
    <div className="flex flex-col gap-4">
      <h2 ref={headingRef} tabIndex={-1} className="sr-only">
        Members
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-role`} className="text-sm font-medium">
            Role
          </label>
          <select
            id={`${id}-role`}
            value={filters.role ?? ''}
            onChange={(event) => applyFilters({ role: (event.target.value || null) as MemberRole | null })}
            className="min-h-11 rounded border px-2"
          >
            <option value="">All roles</option>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-status`} className="text-sm font-medium">
            Status
          </label>
          <select
            id={`${id}-status`}
            value={filters.status ?? ''}
            onChange={(event) => applyFilters({ status: (event.target.value || null) as MemberStatus | null })}
            className="min-h-11 rounded border px-2"
          >
            <option value="">All statuses</option>
            {Object.entries(STATUSES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {/* A 15rem basis, so on a phone it wraps below the selects instead of shrinking beside them. */}
        <form role="search" onSubmit={onSearch} className="flex min-w-0 flex-[1_1_15rem] flex-col gap-1">
          <label htmlFor={`${id}-search`} className="text-sm font-medium">
            Search members
          </label>
          <div className="flex gap-2">
            <input
              id={`${id}-search`}
              type="search"
              // 100 UTF-16 units are at most 100 code points, as `MemberSearch` counts.
              maxLength={100}
              value={searchText}
              placeholder="Name or email"
              onChange={(event) => {
                setSearchText(event.target.value);
                setSearchError(null);
              }}
              aria-invalid={searchProblem !== null}
              aria-describedby={searchProblem ? `${id}-search-error` : undefined}
              className="min-h-11 min-w-0 flex-1 rounded border px-3"
            />
            <button type="submit" className="min-h-11 rounded border px-4 text-sm">
              Search
            </button>
          </div>
          {searchProblem && (
            <p id={`${id}-search-error`} className="text-sm text-red-700">
              {searchProblem}
            </p>
          )}
        </form>
      </div>
      <p ref={messageRef} role="status" tabIndex={-1} data-testid={message ? 'member-message' : undefined} className="text-sm font-medium empty:hidden [overflow-wrap:anywhere]">
        {message}
      </p>
      {body}
      {list}
      {members.isFetchNextPageError && (
        <p role="alert" className="text-sm text-red-700">
          Could not load more members.
        </p>
      )}
      {members.hasNextPage && !members.isRefetchError && (
        // Not while any fetch is out, nor after a failed refresh: a next page would cancel the refresh, or clear its
        // error without repairing the first page (P4-08b review rounds 2 and 3).
        <button
          type="button"
          ref={more.buttonRef}
          disabled={members.isFetching}
          onClick={more.onClick}
          className="self-start rounded border px-4 py-2 text-sm disabled:opacity-50"
        >
          Show more
        </button>
      )}
      {open && dialog(open, open.member.user_id === myId, buildingId, close)}
    </div>
  );
}

function dialog({ kind, member }: Open, self: boolean, buildingId: string, onClose: (message: string | null) => void) {
  if (kind === 'roles') return <RolesDialog member={member} self={self} buildingId={buildingId} onClose={onClose} />;
  if (kind === 'transfer') return <TransferDialog member={member} self={self} buildingId={buildingId} onClose={onClose} />;
  return <MemberDialog kind={kind} member={member} buildingId={buildingId} onClose={onClose} />;
}
