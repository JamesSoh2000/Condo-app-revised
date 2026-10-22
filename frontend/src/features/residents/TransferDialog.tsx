import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { DEBOUNCE_MS, RELATIONSHIPS, relationshipLabel, unitName, useDebounced } from '@/features/onboarding/api';
import { memberRefusal } from '@/features/residents/MemberDialog';
import { useTransfer, useUnitOptions, type Member, type Relationship } from '@/features/residents/api';
import { Modal } from '@/features/residents/Modal';

// `SearchText` (backend app/units/schemas.py) refuses control characters.
const SEARCH_INVALID = 'Search with visible characters only.';
const CONTROL = /\p{Cc}/u;
const UNIT_GONE = 'That unit is no longer available. Choose another.';

/** The refusals that end this dialog: the shared ones, and `not_a_resident`. */
function refusal(error: unknown, member: Member): string | null {
  const shared = memberRefusal(error, member);
  if (shared || !(error instanceof ApiError)) return shared;
  return error.status === 409 && error.code === 'not_a_resident' ? `${member.full_name} is no longer a resident, so this wasn’t done.` : null;
}

/** The unit itself went (another building's, deleted, deactivated): another can be picked (criterion 9). */
const unitGone = (error: unknown) =>
  error instanceof ApiError &&
  ((error.status === 404 && error.code === 'unit_not_found') || (error.status === 409 && error.code === 'unit_inactive'));

interface Props {
  member: Member;
  /** The member is the caller (criterion 6). */
  self: boolean;
  buildingId: string;
  /** With the message to show, or null for Cancel and Escape. Not called once the dialog is gone. */
  onClose: (message: string | null) => void;
}

/**
 * Move a resident to another unit of the building (P4-08e): a unit searched as you type among the active ones (the
 * join form's pattern) and the relationship, starting on the current one. One request per Transfer, as
 * `MemberDialog`.
 */
export function TransferDialog({ member, self, buildingId, onClose }: Props) {
  const transfer = useTransfer(buildingId);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [search, setSearch] = useState('');
  // Checked before trimming, which would drop a leading or trailing tab (review round 1, Codex F3).
  const invalidSearch = CONTROL.test(search);
  const typed = useDebounced(search, DEBOUNCE_MS);
  const term = typed.trim();
  const units = useUnitOptions(buildingId, term, !invalidSearch && !CONTROL.test(typed));
  const [unitId, setUnitId] = useState<string | null>(null);
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

  const options = units.data?.items ?? [];
  // Only a unit the list shows counts: one picked in an earlier list may not be in this one (criterion 8).
  const chosen = options.some((unit) => unit.id === unitId) ? unitId : null;

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
      if (unitGone(error)) {
        setUnitId(null);
        void units.refetch();
        return setFailure({ message: UNIT_GONE });
      }
      return setFailure({ message: rateLimitMessage(error) ?? `Could not transfer ${member.full_name}. Try again.` });
    }
    if (!mounted.current) return;
    const where = moved.unit_label === null ? 'no unit' : `unit ${unitName(moved.tower, moved.unit_label)}`;
    const as = moved.relationship ? ` as ${relationshipLabel(moved.relationship).toLowerCase()}` : '';
    onClose(`${member.full_name} now lives in ${where}${as}.`);
  };

  // A failed refresh shows above the units it kept, as the members list's (review round 1, Codex F1).
  const unitsError = units.isError && (
    <p role="alert" className="text-sm text-red-700">
      {rateLimitMessage(units.error) ?? (units.data ? 'Could not refresh the units.' : 'Could not load the units.')}{' '}
      <button type="button" className="underline" onClick={() => void units.refetch()}>
        Try again
      </button>
    </p>
  );
  let list;
  if (units.isPending) list = <p role="status">Loading units…</p>;
  else if (units.isError && !units.data) list = null;
  else if (options.length === 0) {
    list = <p className="text-sm">{term ? `No active unit starts with “${term}”.` : 'This building has no active units.'}</p>;
  } else {
    list = options.map((unit) => (
      <label key={unit.id} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3 py-2">
        <input type="radio" name={`${id}-unit`} checked={chosen === unit.id} disabled={busy} onChange={() => setUnitId(unit.id)} />
        {unitName(unit.tower, unit.label)}
      </label>
    ));
  }

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
      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor={`${id}-search`} className="text-sm font-medium">
          Unit number
        </label>
        <input
          ref={searchRef}
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          // `SearchText`: at most 20 characters.
          maxLength={20}
          value={search}
          readOnly={busy}
          onChange={(event) => {
            // As the join form: typing starts a new choice (criterion 8).
            setSearch(event.target.value);
            setUnitId(null);
          }}
          aria-invalid={invalidSearch}
          aria-describedby={invalidSearch ? `${id}-search-error` : undefined}
          className="w-full min-w-0 rounded border px-3 py-2"
        />
        {invalidSearch && (
          <p id={`${id}-search-error`} className="text-sm text-red-700">
            {SEARCH_INVALID}
          </p>
        )}
      </div>
      <fieldset className="mt-3" aria-describedby={missing.unit && chosen === null ? `${id}-unit-error` : undefined} aria-busy={units.isFetching}>
        <legend className="mb-1 text-sm font-medium">New unit</legend>
        {unitsError}
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">{list}</div>
        {missing.unit && chosen === null && (
          <p id={`${id}-unit-error`} className="mt-1 text-sm text-red-700">
            Choose a unit.
          </p>
        )}
      </fieldset>
      <fieldset className="mt-3" aria-describedby={missing.relationship && relationship === null ? `${id}-relationship-error` : undefined}>
        <legend className="mb-1 text-sm font-medium">How they relate to the unit</legend>
        <div className="flex flex-col gap-2">
          {RELATIONSHIPS.map((option) => (
            <label key={option.value} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3 py-2">
              <input
                type="radio"
                name={`${id}-relationship`}
                checked={relationship === option.value}
                disabled={busy}
                onChange={() => setRelationship(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
        {missing.relationship && relationship === null && (
          <p id={`${id}-relationship-error`} className="mt-1 text-sm text-red-700">
            Choose how they relate to the unit.
          </p>
        )}
      </fieldset>
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
