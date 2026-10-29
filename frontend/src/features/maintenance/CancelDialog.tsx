import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useCancelMaintenance, type MaintenanceRequest } from '@/features/maintenance/api';
import { CATEGORY_LABEL, firstLine, requestLocation } from '@/features/maintenance/labels';
import { Modal } from '@/features/residents/Modal';

const ENDED = 'It was already started or cancelled.';

/** A refusal that no retry can change: the dialog keeps only Close. */
function endedMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if ((error.status === 409 && error.code === 'invalid_transition') || (error.status === 404 && error.code === 'maintenance_request_not_found')) return ENDED;
  if (error.status === 403 && error.code === 'not_requester') return 'Only the resident who filed this request can cancel it.';
  return null;
}

interface Props {
  buildingId: string;
  item: MaintenanceRequest;
  /** `cancelled` after the 200; false when dismissed, whatever the server said. */
  onClose: (cancelled: boolean) => void;
}

/**
 * Confirm cancelling one's own `submitted` request (P6-04b criterion 7). One request per confirmation: the guard is
 * taken before anything else, ahead of the buttons' `disabled`, which a second click in the same tick doesn't see yet
 * (as `usePackageSubmit`). A refusal no retry can change (a manager started it meanwhile) says so and leaves only
 * Close; the list is refreshed either way (`useCancelMaintenance`).
 */
export function CancelDialog({ buildingId, item, onClose }: Props) {
  const cancel = useCancelMaintenance(buildingId);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; ended: boolean } | null>(null);

  useEffect(() => {
    mounted.current = true;
    keepRef.current?.focus();
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
    // The buttons about to be disabled would drop focus to <body> in a browser.
    dialogRef.current?.focus();
    try {
      await cancel.mutateAsync(item.id);
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = endedMessage(error);
      setFailure({ message: ended ?? rateLimitMessage(error) ?? 'Could not cancel the request. Try again.', ended: ended !== null });
      return;
    }
    if (mounted.current) onClose(true);
  };

  const ended = failure?.ended ?? false;
  return (
    <Modal labelledBy={titleId} busy={busy} onEscape={() => onClose(false)} dialogRef={dialogRef}>
      <h2 id={titleId} className="text-lg font-semibold">
        Cancel this request?
      </h2>
      <p className="mt-2 text-sm">
        {CATEGORY_LABEL[item.category]} · {requestLocation(item)} · {firstLine(item.description)}
      </p>
      <p className="mt-2 text-sm text-slate-700">Cancelling withdraws it before work starts. This can’t be undone.</p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure.message}
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {ended ? (
          <button type="button" onClick={() => onClose(false)} className="min-h-11 rounded border px-4">
            Close
          </button>
        ) : (
          <>
            <button ref={keepRef} type="button" disabled={busy} onClick={() => onClose(false)} className="min-h-11 rounded border px-4 disabled:opacity-50">
              Keep request
            </button>
            <button type="button" disabled={busy} onClick={() => void confirm()} className="min-h-11 rounded bg-red-700 px-4 font-medium text-white disabled:opacity-50">
              Cancel request
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
