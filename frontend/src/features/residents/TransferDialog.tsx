import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { relationshipLabel, unitName } from '@/features/onboarding/api';
import { memberRefusal } from '@/features/residents/MemberDialog';
import { useTransfer, type Member, type Relationship } from '@/features/residents/api';
import { Modal } from '@/features/residents/Modal';
import { RelationshipField, UNIT_GONE, UnitPicker, unitGone, useUnitPicker } from '@/features/residents/UnitPicker';

/** The refusals that end this dialog: the shared ones, and `not_a_resident`. */
function refusal(error: unknown, member: Member): string | null {
  const shared = memberRefusal(error, member);
  if (shared || !(error instanceof ApiError)) return shared;
  return error.status === 409 && error.code === 'not_a_resident' ? `${member.full_name} is no longer a resident, so this wasn’t done.` : null;
}

interface Props {
  member: Member;
  /** The member is the caller (criterion 6). */
  self: boolean;
  buildingId: string;
  /** With the message to show, or null for Cancel and Escape. Not called once the dialog is gone. */
  onClose: (message: string | null) => void;
}

/**
 * Move a resident to another unit of the building (P4-08e): a unit searched as you type among the active ones
 * (`UnitPicker`) and the relationship, starting on the current one. One request per Transfer, as `MemberDialog`.
 */
export function TransferDialog({ member, self, buildingId, onClose }: Props) {
  const transfer = useTransfer(buildingId);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const picker = useUnitPicker(buildingId);
  const { chosen } = picker;
  const [relationship, setRelationship] = useState<Relationship | null>(member.relationship);
  const [missing, setMissing] = useState({ unit: false, relationship: false });
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    searchRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  const confirm = async () => {
    if (inFlight.current) return;
    setMissing({ unit: chosen === null, relationship: relationship === null });
    if (chosen === null || relationship === null) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    let moved;
    try {
      moved = await transfer.mutateAsync({ id: member.membership_id, unit_id: chosen, relationship, self });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, member);
      if (ended) return onClose(ended);
      // The unit itself went: another can be picked (criterion 9).
      if (unitGone(error)) {
        picker.unitGone();
        return setFailure({ message: UNIT_GONE });
      }
      return setFailure({ message: rateLimitMessage(error) ?? `Could not transfer ${member.full_name}. Try again.` });
    }
    if (!mounted.current) return;
    const where = moved.unit_label === null ? 'no unit' : `unit ${unitName(moved.tower, moved.unit_label)}`;
    const as = moved.relationship ? ` as ${relationshipLabel(moved.relationship).toLowerCase()}` : '';
    onClose(`${member.full_name} now lives in ${where}${as}.`);
  };

  const current = member.unit_label === null ? 'no unit' : `unit ${unitName(member.tower, member.unit_label)}`;
  return (
    <Modal labelledBy={`${id}-title`} busy={busy} onEscape={() => onClose(null)} dialogRef={root}>
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Transfer to another unit
      </h2>
      <p className="mt-2 text-sm">
        <span className="font-medium">{member.full_name}</span> ({member.email}), {current}.
      </p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure.message}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-3">
        <UnitPicker picker={picker} legend="New unit" busy={busy} missing={missing.unit} searchRef={searchRef} />
        <RelationshipField value={relationship} onChange={setRelationship} busy={busy} missing={missing.relationship} />
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => onClose(null)} className="rounded border px-4 py-2 disabled:opacity-50">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void confirm()} className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">
          Transfer
        </button>
      </div>
    </Modal>
  );
}
