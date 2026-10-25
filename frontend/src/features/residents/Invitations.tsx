import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useBuilding, useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useLoadMore } from '@/features/lists/useLoadMore';
import { InvitationDialog, roleNames } from '@/features/residents/InvitationDialog';
import { InviteForm } from '@/features/residents/InviteForm';
import { invitationsListKey, useInvitations, useInviting, type Invitation, type InvitationAction, type ListedStatus } from '@/features/residents/api';

const SHOWN: Record<ListedStatus, string> = { pending: 'Pending', expired: 'Expired' };

interface Open {
  kind: InvitationAction['kind'];
  invitation: Invitation;
  opener: HTMLButtonElement;
}

/**
 * The "Invitations" tab (P4-08g, P4-08i): the invite form and the building's pending or expired invitations, each
 * with Resend and Revoke, with P4-08b's list states and "Show more" guards. The mutations ask for the lists again
 * themselves (`useInvite`, `useInvitationAction`).
 */
export function Invitations() {
  const buildingId = useBuildingId();
  const { data: building } = useBuilding();
  const queryClient = useQueryClient();
  const id = useId();
  const [status, setStatus] = useState<ListedStatus>('pending');
  const invitations = useInvitations(buildingId, status);
  const inviting = useInviting(buildingId);
  const [open, setOpen] = useState<Open | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const more = useLoadMore(invitations, () => headingRef.current?.focus());
  // Where focus goes next: state, not a ref, so the effect runs after the commit that shows the message (as
  // `Members`). After a dialog without a message, back to its opener, or to the list's heading if its row went.
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

  // Each change starts from the first page, as `Members`' filters: the cached pages of an earlier visit would all be
  // fetched again.
  const show = (next: ListedStatus) => {
    if (next === status) return;
    queryClient.removeQueries({ queryKey: invitationsListKey(buildingId, next), exact: true });
    setStatus(next);
  };

  const date = building ? new Intl.DateTimeFormat(building.locale, { dateStyle: 'medium', timeZone: building.timezone }) : null;
  const formatDate = (iso: string) => date?.format(new Date(iso)) ?? '';
  const name = `${SHOWN[status]} invitations`;
  const items = invitations.data?.pages.flatMap((page) => page.items) ?? [];

  let body;
  if (invitations.isPending) body = <p role="status">Loading invitations…</p>;
  else if (invitations.isError && !invitations.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(invitations.error) ?? (invitations.data ? 'Could not refresh the invitations.' : 'Could not load the invitations.')}{' '}
        <button type="button" className="underline" onClick={() => void invitations.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const list =
    invitations.data && items.length === 0 ? (
      <p>No {status} invitations.</p>
    ) : (
      invitations.data && (
        <ul ref={more.listRef} aria-label={name} className="flex flex-col gap-3">
          {items.map((invitation) => (
            <li key={invitation.id} tabIndex={-1} className="rounded border bg-white p-3 [overflow-wrap:anywhere]">
              <h3 className="font-medium">{invitation.email}</h3>
              <p className="text-sm text-slate-700">
                {roleNames(invitation.roles)} · {invitation.status === 'expired' ? 'Expired' : 'Expires'} {formatDate(invitation.expires_at)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['resend', 'revoke'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={inviting}
                    aria-label={`${kind === 'resend' ? 'Resend' : 'Revoke'} the invitation to ${invitation.email}`}
                    onClick={(event) => {
                      setMessage(null);
                      setOpen({ kind, invitation, opener: event.currentTarget });
                    }}
                    className="min-h-11 rounded border px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {kind === 'resend' ? 'Resend' : 'Revoke'}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )
    );

  return (
    <div className="flex flex-col gap-4">
      <p ref={messageRef} role="status" tabIndex={-1} data-testid={message ? 'invitation-message' : undefined} className="text-sm font-medium empty:hidden [overflow-wrap:anywhere]">
        {message}
      </p>
      <InviteForm
        buildingId={buildingId}
        onStart={() => setMessage(null)}
        onSent={(email) => {
          setMessage(`Invitation sent to ${email}.`);
          setFocusTo({ target: 'message' });
        }}
      />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
          {name}
        </h2>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-show`} className="text-sm font-medium">
            Show
          </label>
          <select id={`${id}-show`} value={status} onChange={(event) => show(event.target.value as ListedStatus)} className="rounded border px-3 py-2">
            {(Object.keys(SHOWN) as ListedStatus[]).map((value) => (
              <option key={value} value={value}>
                {SHOWN[value]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {body}
      {list}
      {invitations.isFetchNextPageError && (
        <p role="alert" className="text-sm text-red-700">
          Could not load more invitations.
        </p>
      )}
      {invitations.hasNextPage && !invitations.isRefetchError && (
        // As PendingRequests: not while any fetch is out (a next page would cancel a refresh and append to the old
        // pages), and not after a failed refresh (Try again first; P4-08b review rounds 2 and 3).
        <button
          type="button"
          ref={more.buttonRef}
          disabled={invitations.isFetching}
          onClick={more.onClick}
          className="self-start rounded border px-4 py-2 text-sm disabled:opacity-50"
        >
          Show more
        </button>
      )}
      {open && <InvitationDialog kind={open.kind} invitation={open.invitation} buildingId={buildingId} formatDate={formatDate} onClose={close} />}
    </div>
  );
}
