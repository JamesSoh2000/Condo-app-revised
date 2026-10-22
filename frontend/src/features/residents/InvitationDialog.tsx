import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { ROLE_LABELS, useInvitationAction, type Invitation, type InvitationAction, type MemberRole } from '@/features/residents/api';
import { Modal } from '@/features/residents/Modal';

type Kind = InvitationAction['kind'];
/** `Role`'s order: the server lists an invitation's roles alphabetically. */
const ROLES = Object.keys(ROLE_LABELS) as MemberRole[];
export const roleNames = (roles: readonly MemberRole[]) =>
  ROLES.filter((role) => roles.includes(role))
    .map((role) => ROLE_LABELS[role])
    .join(', ');

const COPY: Record<Kind, { title: string; confirm: string; note: string }> = {
  resend: {
    title: 'Resend this invitation?',
    confirm: 'Resend',
    note: 'The link already sent stops working, and a new one, valid for 7 days, is emailed.',
  },
  revoke: { title: 'Revoke this invitation?', confirm: 'Revoke', note: 'The link already sent stops working.' },
};

/** The refusals that end the dialog (criterion 6): trying again would get the same answer, so the tab says why. */
function refusal(error: unknown, kind: Kind, invitation: Invitation): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404 && error.code === 'invitation_not_found') return 'This invitation no longer exists.';
  if (error.status === 403 && error.code === 'forbidden_role') return 'You can no longer manage invitations in this building.';
  if (error.status !== 409) return null;
  if (error.code === 'invalid_transition') return 'This invitation was already accepted or revoked.';
  if (kind === 'resend' && error.code === 'invitation_pending') {
    return `${invitation.email} already has another pending invitation. Revoke one of them first.`;
  }
  return null;
}

interface Props {
  kind: Kind;
  invitation: Invitation;
  buildingId: string;
  /** The building's date format, for the new expiry. */
  formatDate: (iso: string) => string;
  /** With the message to show, or null for Cancel and Escape. Not called once the dialog is gone. */
  onClose: (message: string | null) => void;
}

/**
 * The confirmation for resending or revoking one invitation (P4-08i), as `MemberDialog`: one request per confirmation
 * (the guard is taken before anything else), the invitation it was opened with even if a refetch changes the row,
 * and the server's conditional update decides (409 `invalid_transition`).
 */
export function InvitationDialog({ kind, invitation, buildingId, formatDate, onClose }: Props) {
  const act = useInvitationAction(buildingId);
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // Its own object each time, so the same message again still moves focus to it.
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = COPY[kind];

  useEffect(() => {
    mounted.current = true;
    cancel.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    let done;
    try {
      done = await act.mutateAsync({ kind, id: invitation.id });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, kind, invitation);
      if (ended) return onClose(ended);
      return setFailure({ message: rateLimitMessage(error) ?? `Could not ${kind} the invitation. Try again.` });
    }
    if (!mounted.current) return;
    onClose(
      done
        ? `A new invitation was sent to ${done.email}. It expires ${formatDate(done.expires_at)}.`
        : `The invitation to ${invitation.email} was revoked.`,
    );
  };

  return (
    <Modal labelledBy={titleId} busy={busy} onEscape={() => onClose(null)} dialogRef={root}>
      <h2 id={titleId} className="text-lg font-semibold">
        {copy.title}
      </h2>
      <p className="mt-2 text-sm [overflow-wrap:anywhere]">
        <span className="font-medium">{invitation.email}</span> ({roleNames(invitation.roles)}).
      </p>
      <p className="mt-1 text-sm text-slate-600">{copy.note}</p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure.message}
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button ref={cancel} type="button" disabled={busy} onClick={() => onClose(null)} className="rounded border px-4 py-2 disabled:opacity-50">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className={`rounded px-4 py-2 font-medium text-white disabled:opacity-50 ${kind === 'revoke' ? 'bg-red-700' : 'bg-slate-900'}`}
        >
          {copy.confirm}
        </button>
      </div>
    </Modal>
  );
}
