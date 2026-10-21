import { useEffect, useRef, useState } from 'react';

import { useBuilding, useBuildingId } from '@/app/BuildingProvider';
import { relationshipLabel, unitName } from '@/features/onboarding/api';
import { DecisionDialog, type Outcome } from '@/features/residents/DecisionDialog';
import { usePendingRequests, type JoinRequest } from '@/features/residents/api';

interface Open {
  kind: 'approve' | 'deny';
  request: JoinRequest;
  opener: HTMLButtonElement;
}

/**
 * The "Pending requests" tab (P4-08b): the building's pending join requests, each with Approve and Deny. The
 * dialog keeps the request it was opened with, so a refetch that drops the row leaves it as it was, and the
 * server's answer (409 `already_decided`) says what happened (criterion 13).
 */
export function PendingRequests() {
  const buildingId = useBuildingId();
  const { data: building } = useBuilding();
  const requests = usePendingRequests(buildingId);
  const [open, setOpen] = useState<Open | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  // Where focus goes once the dialog has closed: its opener, or the message when the row is leaving the list. State,
  // not a ref: the effect then runs after the commit that shows the message. A ref read by an effect on every render
  // was taken by the list refetch's pending effect, while the message was still empty and hidden (Chromium).
  const [focusTo, setFocusTo] = useState<{ target: HTMLElement | 'message' } | null>(null);
  useEffect(() => {
    if (focusTo) (focusTo.target === 'message' ? messageRef.current : focusTo.target)?.focus();
  }, [focusTo]);

  const close = (outcome: Outcome | null) => {
    if (outcome) setMessage(outcome.message);
    const back = !outcome?.decided && open?.opener.isConnected ? open.opener : null;
    setFocusTo({ target: back ?? 'message' });
    setOpen(null);
  };

  const date = building ? new Intl.DateTimeFormat(building.locale, { dateStyle: 'medium', timeZone: building.timezone }) : null;
  const items = requests.data?.pages.flatMap((page) => page.items) ?? [];

  let body;
  if (requests.isPending) body = <p role="status">Loading requests…</p>;
  else if (requests.isError && !requests.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {requests.data ? 'Could not refresh the requests.' : 'Could not load the requests.'}{' '}
        <button type="button" className="underline" onClick={() => void requests.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const list =
    requests.data && items.length === 0 ? (
      <p>No pending requests.</p>
    ) : (
      requests.data && (
        <ul aria-label="Pending requests" className="flex flex-col gap-3">
          {items.map((request) => (
            <li key={request.id} className="rounded border bg-white p-3 [overflow-wrap:anywhere]">
              <h3 className="font-medium">{request.full_name}</h3>
              <p className="text-sm text-slate-700">{request.email}</p>
              <p className="text-sm text-slate-700">
                Unit {unitName(request.tower, request.unit_label)} · {relationshipLabel(request.relationship)} · Asked{' '}
                {date?.format(new Date(request.submitted_at))}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['approve', 'deny'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-label={`${kind === 'approve' ? 'Approve' : 'Deny'} ${request.full_name}`}
                    onClick={(event) => {
                      setMessage(null);
                      setOpen({ kind, request, opener: event.currentTarget });
                    }}
                    className={`min-h-11 rounded px-4 py-2 text-sm font-medium ${kind === 'approve' ? 'bg-slate-900 text-white' : 'border border-red-700 text-red-700'}`}
                  >
                    {kind === 'approve' ? 'Approve' : 'Deny'}
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
      <h2 className="sr-only">Pending requests</h2>
      <p ref={messageRef} role="status" tabIndex={-1} data-testid={message ? 'decision-message' : undefined} className="text-sm font-medium empty:hidden">
        {message}
      </p>
      {body}
      {list}
      {requests.isFetchNextPageError && (
        <p role="alert" className="text-sm text-red-700">
          Could not load more requests.
        </p>
      )}
      {requests.hasNextPage && (
        <button
          type="button"
          disabled={requests.isFetchingNextPage}
          onClick={() => void requests.fetchNextPage()}
          className="self-start rounded border px-4 py-2 text-sm disabled:opacity-50"
        >
          Show more
        </button>
      )}
      {open && <DecisionDialog kind={open.kind} request={open.request} buildingId={buildingId} onClose={close} />}
    </div>
  );
}
