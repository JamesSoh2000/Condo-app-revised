import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { memberRefusal } from '@/features/residents/MemberDialog';
import { ROLE_LABELS, useRolesChange, type Member, type MemberRole } from '@/features/residents/api';
import { Modal } from '@/features/residents/Modal';

const ROLES = Object.keys(ROLE_LABELS) as MemberRole[];

/** The refusals that end this dialog: the shared ones, and those of a roles change. */
function refusal(error: unknown, member: Member): string | null {
  const shared = memberRefusal(error, member);
  if (shared || !(error instanceof ApiError) || error.status !== 409) return shared;
  if (error.code === 'no_roles_left') return 'A member must keep at least one role, so this wasn’t done.';
  if (error.code === 'resident_has_unit') return `${member.full_name} lives in a unit, so Resident can’t be removed while they do.`;
  return null;
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
 * Change an active member's roles (P4-08e). The boxes start from the roles the row showed when it opened, and Save
 * sends only what was changed here (`add`, `remove`): a change made elsewhere meanwhile to another role is kept,
 * and the server decides (criterion 13). One request per Save, as `MemberDialog`.
 */
export function RolesDialog({ member, self, buildingId, onClose }: Props) {
  const change = useRolesChange(buildingId);
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [checked, setChecked] = useState<ReadonlySet<MemberRole>>(() => new Set(member.roles));
  // Its own object each time, so the same message again still moves focus to it.
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    first.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  const save = async () => {
    if (inFlight.current) return;
    const add = ROLES.filter((role) => checked.has(role) && !member.roles.includes(role));
    const remove = ROLES.filter((role) => !checked.has(role) && member.roles.includes(role));
    if (checked.size === 0) return setFailure({ message: 'A member must keep at least one role.' });
    if (add.length === 0 && remove.length === 0) return setFailure({ message: 'Change at least one role.' });
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await change.mutateAsync({ id: member.membership_id, add, remove, self });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const ended = refusal(error, member);
      if (ended) return onClose(ended);
      return setFailure({ message: rateLimitMessage(error) ?? `Could not change ${member.full_name}’s roles. Try again.` });
    }
    if (mounted.current) onClose(`${member.full_name}’s roles were updated.`);
  };

  const toggle = (role: MemberRole) =>
    setChecked((current) => {
      const next = new Set(current);
      if (!next.delete(role)) next.add(role);
      return next;
    });

  return (
    <Modal labelledBy={titleId} busy={busy} onEscape={() => onClose(null)} dialogRef={root}>
      <h2 id={titleId} className="text-lg font-semibold">
        Change roles
      </h2>
      <p className="mt-2 text-sm">
        <span className="font-medium">{member.full_name}</span> ({member.email})
      </p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure.message}
        </div>
      )}
      <fieldset className="mt-3">
        <legend className="mb-1 text-sm font-medium">Roles</legend>
        <div className="flex flex-col gap-2">
          {ROLES.map((role, index) => (
            <label key={role} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3 py-2">
              <input
                ref={index === 0 ? first : undefined}
                type="checkbox"
                checked={checked.has(role)}
                disabled={busy}
                onChange={() => toggle(role)}
              />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => onClose(null)} className="rounded border px-4 py-2 disabled:opacity-50">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">
          Save
        </button>
      </div>
    </Modal>
  );
}
