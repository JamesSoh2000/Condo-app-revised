import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import { unitName } from '@/features/onboarding/api';
import { useMemberAction, type Member, type MemberActionKind } from '@/features/residents/api';
import { Modal } from '@/features/residents/Modal';
import { REASON_MESSAGES, ReasonField, reasonError } from '@/features/residents/reason';

const COPY: Record<MemberActionKind, { title: string; confirm: string; verb: string; done: string }> = {
  suspend: { title: 'Suspend this member?', confirm: 'Suspend', verb: 'suspend', done: 'was suspended.' },
  reactivate: { title: 'Reactivate this member?', confirm: 'Reactivate', verb: 'reactivate', done: 'was reactivated.' },
  deactivate: { title: 'Move this member out?', confirm: 'Move out', verb: 'move out', done: 'was moved out.' },
};

/**
 * The refusals every member dialog ends with (P4-08c, P4-08e): the member can't be changed as shown, so the page
 * says why. Null for any other error.
 */
export function memberRefusal(error: unknown, member: Member): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404 && error.code === 'member_not_found') return 'This member is no longer in this building.';
  if (error.status !== 409) return null;
  switch (error.code) {
    case 'last_manager':
      return 'The building must keep at least one active property manager, so this wasn’t done.';
    case 'membership_not_active':
      return `${member.full_name} is no longer active, so this wasn’t done. Check the list and try again.`;
    case 'occupancy_changed':
      return `${member.full_name}’s unit changed at the same time, so this wasn’t done. Check the list and try again.`;
  }
  return null;
}

/** The refusals that end this dialog: the shared ones, and those of the status actions. */
function refusal(error: unknown, kind: MemberActionKind, member: Member): string | null {
  const shared = memberRefusal(error, member);
  if (shared || !(error instanceof ApiError) || error.status !== 409) return shared;
  switch (error.code) {
    case 'cannot_target_self':
      return kind === 'deactivate' ? 'You can’t move yourself out.' : 'You can’t suspend yourself.';
    case 'invalid_transition':
      return `${member.full_name}’s status changed in the meantime, so this wasn’t done. Check the list and try again.`;
  }
  return null;
}

interface Props {
  kind: MemberActionKind;
  member: Member;
  buildingId: string;
  /** With the message to show, or null for Cancel and Escape. Not called once the dialog is gone. */
  onClose: (message: string | null) => void;
}

/**
 * The confirmation for one member action (P4-08c), with a reason for suspend and move-out. As `DecisionDialog`: one
 * request per confirmation (the guard is taken before anything else), the member it was opened with even if a
 * refetch changes the row, and the server's conditional update decides (409 `invalid_transition`).
 */
export function MemberDialog({ kind, member, buildingId, onClose }: Props) {
  const act = useMemberAction(buildingId);
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const withReason = kind !== 'reactivate';
  const copy = COPY[kind];

  useEffect(() => {
    mounted.current = true;
    (withReason ? field.current : cancel.current)?.focus();
    return () => {
      mounted.current = false;
    };
  }, [withReason]);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  const confirm = async () => {
    if (inFlight.current) return;
    const invalid = withReason ? reasonError(reason) : null;
    setFieldError(invalid);
    if (invalid) return field.current?.focus();
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      const id = member.membership_id;
      await act.mutateAsync(kind === 'reactivate' ? { kind, id } : { kind, id, reason });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, kind, member);
      if (ended) return onClose(ended);
      const placed = withReason ? serverFieldErrors(error, ['reason'], { reason: REASON_MESSAGES }) : null;
      if (placed) {
        setFieldError(placed[0].message);
        return field.current?.focus();
      }
      return setFailure(rateLimitMessage(error) ?? `Could not ${copy.verb} ${member.full_name}. Try again.`);
    }
    if (mounted.current) onClose(`${member.full_name} ${copy.done}`);
  };

  const unit = member.unit_label === null ? null : unitName(member.tower, member.unit_label);
  const notes: Record<MemberActionKind, string> = {
    suspend: 'They lose access to this building until a manager reactivates them. Their unit and roles are kept.',
    reactivate: 'They get their access to this building back, with their roles.',
    deactivate: `${unit ? `Their occupancy of unit ${unit} ends and they` : 'They'} lose access to this building.`,
  };
  return (
    <Modal labelledBy={titleId} busy={busy} onEscape={() => onClose(null)} dialogRef={root}>
      <h2 id={titleId} className="text-lg font-semibold">
        {copy.title}
      </h2>
      <p className="mt-2 text-sm">
        <span className="font-medium">{member.full_name}</span> ({member.email}), {unit ? `unit ${unit}` : 'no unit'}.
      </p>
      <p className="mt-1 text-sm text-slate-600">{notes[kind]}</p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure}
        </div>
      )}
      {withReason && (
        <ReasonField
          label="Reason (only managers see it)"
          value={reason}
          error={fieldError}
          busy={busy}
          fieldRef={field}
          onChange={(value) => {
            setReason(value);
            setFieldError(null);
          }}
        />
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button ref={cancel} type="button" disabled={busy} onClick={() => onClose(null)} className="rounded border px-4 py-2 disabled:opacity-50">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className={`rounded px-4 py-2 font-medium text-white disabled:opacity-50 ${kind === 'reactivate' ? 'bg-slate-900' : 'bg-red-700'}`}
        >
          {copy.confirm}
        </button>
      </div>
    </Modal>
  );
}
