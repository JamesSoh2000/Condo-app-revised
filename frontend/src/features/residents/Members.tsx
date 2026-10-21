import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { relationshipLabel, unitName } from '@/features/onboarding/api';
import { MemberDialog } from '@/features/residents/MemberDialog';
import {
  useMembers,
  type Member,
  type MemberActionKind,
  type MemberFilters,
  type MemberRole,
  type MemberStatus,
} from '@/features/residents/api';

const ROLES: Record<MemberRole, string> = {
  resident: 'Resident',
  security: 'Security',
  property_management: 'Property manager',
  council: 'Council',
};
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
const ACTION_LABELS: Record<MemberActionKind, string> = { suspend: 'Suspend', reactivate: 'Reactivate', deactivate: 'Move out' };
// `MemberSearch` (backend app/memberships/schemas.py) refuses control characters.
const SEARCH_INVALID = 'Search with visible characters only.';

interface Open {
  kind: MemberActionKind;
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
  const [filters, setFilters] = useState<MemberFilters>({ role: null, status: null, search: '' });
  const [searchText, setSearchText] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const members = useMembers(buildingId, filters);
  const [open, setOpen] = useState<Open | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
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

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    if (/\p{Cc}/u.test(searchText)) return setSearchError(SEARCH_INVALID);
    setSearchError(null);
    setFilters((current) => ({ ...current, search: searchText.trim() }));
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
        <ul aria-label="Members" className="flex flex-col gap-3">
          {items.map((member) => (
            <li key={member.membership_id} className="rounded border bg-white p-3 [overflow-wrap:anywhere]">
              <h3 className="font-medium">{member.full_name}</h3>
              <p className="text-sm text-slate-700">{member.email}</p>
              <p className="text-sm text-slate-700">
                {STATUSES[member.status]} · {member.roles.map((role) => ROLES[role]).join(', ') || 'No roles'}
              </p>
              {member.unit_label !== null && (
                <p className="text-sm text-slate-700">
                  Unit {unitName(member.tower, member.unit_label)}
                  {member.relationship && ` · ${relationshipLabel(member.relationship)}`}
                </p>
              )}
              {member.status_reason && <p className="text-sm text-slate-700">Reason: {member.status_reason}</p>}
              {ACTIONS[member.status].length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {ACTIONS[member.status].map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      aria-label={`${ACTION_LABELS[kind]} ${member.full_name}`}
                      onClick={(event) => {
                        setMessage(null);
                        setOpen({ kind, member, opener: event.currentTarget });
                      }}
                      className={`min-h-11 rounded px-4 py-2 text-sm font-medium ${kind === 'reactivate' ? 'bg-slate-900 text-white' : 'border border-red-700 text-red-700'}`}
                    >
                      {ACTION_LABELS[kind]}
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
            onChange={(event) => setFilters((current) => ({ ...current, role: (event.target.value || null) as MemberRole | null }))}
            className="min-h-11 rounded border px-2"
          >
            <option value="">All roles</option>
            {Object.entries(ROLES).map(([value, label]) => (
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
            onChange={(event) => setFilters((current) => ({ ...current, status: (event.target.value || null) as MemberStatus | null }))}
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
          disabled={members.isFetching}
          onClick={() => void members.fetchNextPage({ cancelRefetch: false })}
          className="self-start rounded border px-4 py-2 text-sm disabled:opacity-50"
        >
          Show more
        </button>
      )}
      {open && <MemberDialog kind={open.kind} member={open.member} buildingId={buildingId} onClose={close} />}
    </div>
  );
}
