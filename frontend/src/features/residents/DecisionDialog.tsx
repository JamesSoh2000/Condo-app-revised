import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import { relationshipLabel, unitName } from '@/features/onboarding/api';
import { useDecide, type JoinRequest } from '@/features/residents/api';
import { Modal } from '@/features/residents/Modal';
import { REASON_MESSAGES, ReasonField, reasonError } from '@/features/residents/reason';

/** What the page shows once the dialog closes; `decided` when the request has left the pending list. */
export interface Outcome {
  message: string;
  decided: boolean;
}

/** The refusals that end the dialog: the request can't be decided as shown, so the page says why. */
function refusal(error: unknown, request: JoinRequest): Outcome | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409 && error.code === 'already_decided') {
    return { message: 'Already decided by someone else.', decided: true };
  }
  if (error.status === 409 && error.code === 'membership_not_pending') {
    const message =
      'This request can no longer be decided: the person’s membership changed (for example, they accepted an invitation).';
    return { message, decided: true };
  }
  if (error.status === 409 && error.code === 'unit_inactive') {
    const unit = unitName(request.tower, request.unit_label);
    return { message: `Unit ${unit} is no longer active, so this request can’t be approved. Deny it instead.`, decided: false };
  }
  if (error.status === 404 && error.code === 'onboarding_request_not_found') {
    return { message: 'This request no longer exists.', decided: true };
  }
  return null;
}

interface Props {
  kind: 'approve' | 'deny';
  request: JoinRequest;
  buildingId: string;
  /** With the outcome to show, or null for Cancel and Escape. Not called once the dialog is gone. */
  onClose: (outcome: Outcome | null) => void;
}

/**
 * The confirmation for one decision (P4-08b): a modal dialog naming the request, with the reason field for a
 * denial. One request per confirmation: the guard is taken before anything else in the handler, ahead of the
 * button's `disabled` (which a second click in the same tick doesn't see yet); the server's conditional update
 * still decides between two managers (409 `already_decided`, must-explain 1).
 */
export function DecisionDialog({ kind, request, buildingId, onClose }: Props) {
  const decide = useDecide(buildingId);
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
  const deny = kind === 'deny';

  useEffect(() => {
    mounted.current = true;
    (deny ? field.current : cancel.current)?.focus();
    return () => {
      mounted.current = false;
    };
  }, [deny]);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  const confirm = async () => {
    if (inFlight.current) return;
    const invalid = deny ? reasonError(reason) : null;
    setFieldError(invalid);
    if (invalid) return field.current?.focus();
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await decide.mutateAsync(deny ? { kind, id: request.id, reason } : { kind, id: request.id });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, request);
      if (ended) return onClose(ended);
      const placed = deny ? serverFieldErrors(error, ['reason'], { reason: REASON_MESSAGES }) : null;
      if (placed) {
        setFieldError(placed[0].message);
        return field.current?.focus();
      }
      return setFailure(rateLimitMessage(error) ?? `Could not ${kind} the request. Try again.`);
    }
    if (!mounted.current) return;
    const message = deny ? `${request.full_name}’s request was denied.` : `${request.full_name} was approved.`;
    onClose({ message, decided: true });
  };

  const unit = unitName(request.tower, request.unit_label);
  // Escape closes, and Tab stays inside (`Modal`); nothing closes it while the decision is sent.
  return (
    <Modal labelledBy={titleId} busy={busy} onEscape={() => onClose(null)} dialogRef={root}>
      <h2 id={titleId} className="text-lg font-semibold">
        {deny ? 'Deny this request?' : 'Approve this request?'}
      </h2>
      <p className="mt-2 text-sm">
        <span className="font-medium">{request.full_name}</span> ({request.email}) asked to join: unit {unit},{' '}
        {relationshipLabel(request.relationship)}.
      </p>
      <p className="mt-1 text-sm text-slate-600">
        {deny ? 'They will see your reason and can ask again.' : 'They become a resident of the unit and are told.'}
      </p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure}
        </div>
      )}
      {deny && (
        <ReasonField
          label="Reason (they will see it)"
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
          className={`rounded px-4 py-2 font-medium text-white disabled:opacity-50 ${deny ? 'bg-red-700' : 'bg-slate-900'}`}
        >
          {deny ? 'Deny' : 'Approve'}
        </button>
      </div>
    </Modal>
  );
}
