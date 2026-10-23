import { useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import { unitName } from '@/features/onboarding/api';
import { useUnitOccupants, type Package } from '@/features/packages/api';
import { PackageDialog, textError, textMessages, usePackageSubmit } from '@/features/packages/PackageDialog';

const MAX = 120;
const EMPTY = 'Type their name.';
const SOMEONE_ELSE = 'other';
const REFUSED = 'That person can’t collect this package now. Choose someone else or type a name.';

interface Choice {
  membershipId: string;
  name: string;
  recipient?: boolean;
}

/**
 * Hand a waiting package out (P5-03d criterion 2): to its named recipient, someone who lives in its unit now, or a
 * name typed at the desk; the server takes exactly one of a membership and a name. The recipient comes first, from
 * the package itself, since one who moved out may still collect (D2); nothing is chosen until the desk chooses. A
 * member the server refuses (422 `invalid_pickup_member`) is not offered again in this dialog.
 */
export function PickupDialog({ item, onClose }: { item: Package; onClose: (message: string | null) => void }) {
  const occupants = useUnitOccupants(useBuildingId(), item.unit_id);
  const { root, busy, failure, submit } = usePackageSubmit(onClose, 'Could not record the pickup. Try again.');
  const nameRef = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [refused, setRefused] = useState<string[]>([]);
  const [error, setError] = useState<{ field: 'choice' | 'name'; message: string } | null>(null);
  const id = useId();

  const choices: Choice[] = [];
  // Staff always get the recipient's name (P5-03a); the fallback only keeps the type honest.
  if (item.recipient_membership_id) choices.push({ membershipId: item.recipient_membership_id, name: item.recipient_name ?? 'The recipient', recipient: true });
  for (const occupant of occupants.data ?? []) {
    if (occupant.membership_id !== item.recipient_membership_id) choices.push({ membershipId: occupant.membership_id, name: occupant.full_name });
  }
  const offered = choices.filter((c) => !refused.includes(c.membershipId));
  // A choice counts only while it is still offered.
  const chosen = choice === SOMEONE_ELSE || offered.some((c) => c.membershipId === choice) ? choice : null;

  const failed = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'invalid_pickup_member' && chosen !== SOMEONE_ELSE && chosen !== null) {
      setRefused((ids) => [...ids, chosen]);
      setChoice(null);
      void occupants.refetch();
      setError({ field: 'choice', message: REFUSED });
      return true;
    }
    const placed = serverFieldErrors(err, ['picked_up_by_name'], { picked_up_by_name: textMessages(MAX, EMPTY) });
    if (!placed) return false;
    setError({ field: 'name', message: placed[0].message });
    nameRef.current?.focus();
    return true;
  };

  const confirm = () => {
    if (busy) return;
    if (chosen === null) return setError({ field: 'choice', message: 'Choose who is collecting it.' });
    const typed = chosen === SOMEONE_ELSE ? textError(name, MAX, EMPTY) : null;
    if (typed) {
      setError({ field: 'name', message: typed });
      return nameRef.current?.focus();
    }
    setError(null);
    const who = chosen === SOMEONE_ELSE ? name.trim() : offered.find((c) => c.membershipId === chosen)?.name;
    const done = `Unit ${unitName(item.unit_tower, item.unit_label)}’s package was handed to ${who}.`;
    const body = chosen === SOMEONE_ELSE ? { picked_up_by_name: name.trim() } : { picked_up_by_membership_id: chosen };
    void submit({ kind: 'pickup', id: item.id, body }, done, failed);
  };

  const message = (field: 'choice' | 'name') =>
    error?.field === field && (
      <p id={`${id}-${field}-error`} className="text-sm text-red-700">
        {error.message}
      </p>
    );

  return (
    <PackageDialog title="Hand out this package?" item={item} confirm="Hand out" busy={busy} failure={failure} dialogRef={root} onConfirm={confirm} onCancel={() => onClose(null)}>
      <fieldset aria-describedby={error?.field === 'choice' ? `${id}-choice-error` : undefined} className="mt-3 min-w-0">
        <legend className="mb-1 text-sm font-medium">Who is collecting it?</legend>
        <div className="flex flex-col gap-1">
          {[...offered, { membershipId: SOMEONE_ELSE, name: 'Someone else' }].map((c) => (
            <label key={c.membershipId} className="flex min-h-11 min-w-0 items-center gap-2">
              <input
                type="radio"
                name={`${id}-who`}
                checked={chosen === c.membershipId}
                disabled={busy}
                onChange={() => {
                  setChoice(c.membershipId);
                  setError(null);
                }}
              />
              <span className="min-w-0">{c.recipient ? `${c.name} (recipient)` : c.name}</span>
            </label>
          ))}
        </div>
        {occupants.isPending && <p className="text-sm text-slate-600">Loading who lives in the unit…</p>}
        {occupants.isError && (
          <p className="text-sm text-red-700">
            {rateLimitMessage(occupants.error) ?? 'Could not load who lives in the unit.'}{' '}
            <button type="button" className="underline" onClick={() => void occupants.refetch()}>
              Try again
            </button>
          </p>
        )}
        {message('choice')}
      </fieldset>
      {chosen === SOMEONE_ELSE && (
        <div className="mt-3 flex flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            Their name
          </label>
          {/* `picked_up_by_name` varchar(120): 120 code points take at most 240 UTF-16 units; `textError` counts. */}
          <input
            ref={nameRef}
            id={`${id}-name`}
            maxLength={2 * MAX}
            autoComplete="off"
            value={name}
            readOnly={busy}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            aria-invalid={error?.field === 'name'}
            aria-describedby={error?.field === 'name' ? `${id}-name-error` : undefined}
            className="w-full min-w-0 rounded border px-3 py-2"
          />
          {message('name')}
        </div>
      )}
    </PackageDialog>
  );
}
