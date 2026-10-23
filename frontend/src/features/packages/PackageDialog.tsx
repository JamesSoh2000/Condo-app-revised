import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { codePoints, rateLimitMessage } from '@/features/auth/formErrors';
import { unitName } from '@/features/onboarding/api';
import { usePackageAction, type Package, type PackageAction } from '@/features/packages/api';
import { Modal } from '@/features/residents/Modal';

export const ENDED = 'Already picked up or returned by a colleague.';
export const VISIBLE_ONLY = 'Use visible characters only.';
// `PickupName` and `ReturnReason` (backend app/packages/schemas.py): no control character, checked before the strip;
// lone surrogates too, which Postgres refuses (the CLAUDE.md lesson). Then 1–max code points, as Pydantic counts.
const INVISIBLE = /[\p{Cc}\p{Cs}]/u;

export function textError(value: string, max: number, empty: string): string | null {
  if (INVISIBLE.test(value)) return VISIBLE_ONLY;
  const length = codePoints(value.trim());
  if (length === 0) return empty;
  return length > max ? `Use at most ${max} characters.` : null;
}

/** A 422 on the text field, by its `type`, for `serverFieldErrors`. */
export const textMessages = (max: number, empty: string): Record<string, string> => ({
  string_too_short: empty,
  string_too_long: `Use at most ${max} characters.`,
  control_characters: VISIBLE_ONLY,
});

/**
 * Send one action from a dialog: one request per confirmation (the guard is taken before anything else, ahead of the
 * buttons' `disabled`, which a second click in the same tick doesn't see yet). A 409 `invalid_transition` or 404
 * `package_not_found` ends the dialog with `ENDED` (criterion 1); `onFailure` places any other refusal, else the
 * dialog says `failed`. Nothing is called once the dialog is gone.
 */
export function usePackageSubmit(onClose: (message: string | null) => void, failed: string) {
  const action = usePackageAction(useBuildingId());
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async (sent: PackageAction, done: string, onFailure: (error: unknown) => boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await action.mutateAsync(sent);
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended =
        error instanceof ApiError &&
        ((error.status === 409 && error.code === 'invalid_transition') || (error.status === 404 && error.code === 'package_not_found'));
      if (ended) return onClose(ENDED);
      if (!onFailure(error)) setFailure(rateLimitMessage(error) ?? failed);
      return;
    }
    if (mounted.current) onClose(done);
  };
  return { root, busy, failure, submit };
}

interface Props {
  title: string;
  item: Package;
  confirm: string;
  busy: boolean;
  failure: string | null;
  dialogRef: RefObject<HTMLDivElement>;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

/** The shell of both package dialogs: the residents `Modal`, the package it acts on, the failure, the buttons. */
export function PackageDialog({ title, item, confirm, busy, failure, dialogRef, onConfirm, onCancel, children }: Props) {
  const titleId = useId();
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  return (
    <Modal labelledBy={titleId} busy={busy} onEscape={onCancel} dialogRef={dialogRef}>
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      <p className="mt-2 text-sm">
        {item.carrier} package for unit {unitName(item.unit_tower, item.unit_label)}
        {item.description && ` · ${item.description}`}.
      </p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure}
        </div>
      )}
      {children}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="min-h-11 rounded border px-4 disabled:opacity-50">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={onConfirm} className="min-h-11 rounded bg-slate-900 px-4 font-medium text-white disabled:opacity-50">
          {confirm}
        </button>
      </div>
    </Modal>
  );
}
