import { useEffect, useRef, useState } from 'react';

import { useBuilding, useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { InviteForm } from '@/features/residents/InviteForm';
import { ROLE_LABELS, useInvitations, type MemberRole } from '@/features/residents/api';

/** `Role`'s order: the server lists an invitation's roles alphabetically. */
const ROLES = Object.keys(ROLE_LABELS) as MemberRole[];

/**
 * The "Invitations" tab (P4-08g): the staff invite form and the building's pending invitations, with P4-08b's list
 * states and "Show more" guards. The form's create asks for the list again itself (`useInvite`).
 */
export function Invitations() {
  const buildingId = useBuildingId();
  const { data: building } = useBuilding();
  const invitations = useInvitations(buildingId);
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  // State, not a ref, so the effect runs after the commit that shows the message (as PendingRequests).
  const [focusMessage, setFocusMessage] = useState<object | null>(null);
  useEffect(() => {
    if (focusMessage) messageRef.current?.focus();
  }, [focusMessage]);

  const date = building ? new Intl.DateTimeFormat(building.locale, { dateStyle: 'medium', timeZone: building.timezone }) : null;
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
      <p>No pending invitations.</p>
    ) : (
      invitations.data && (
        <ul aria-label="Pending invitations" className="flex flex-col gap-3">
          {items.map((invitation) => (
            <li key={invitation.id} className="rounded border bg-white p-3 [overflow-wrap:anywhere]">
              <h3 className="font-medium">{invitation.email}</h3>
              <p className="text-sm text-slate-700">
                {ROLES.filter((role) => invitation.roles.includes(role))
                  .map((role) => ROLE_LABELS[role])
                  .join(', ')}{' '}
                · Expires {date?.format(new Date(invitation.expires_at))}
              </p>
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
          setFocusMessage({});
        }}
      />
      <h2 className="text-lg font-semibold">Pending invitations</h2>
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
          disabled={invitations.isFetching}
          onClick={() => void invitations.fetchNextPage({ cancelRefetch: false })}
          className="self-start rounded border px-4 py-2 text-sm disabled:opacity-50"
        >
          Show more
        </button>
      )}
    </div>
  );
}
