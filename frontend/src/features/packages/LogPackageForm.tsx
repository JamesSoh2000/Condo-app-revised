import { useCallback, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { FileUpload } from '@/features/files/FileUpload';
import type { UploadStatus } from '@/features/files/useUpload';
import { CARRIERS, useLogPackage, useUnitOccupants } from '@/features/packages/api';
import { UNIT_GONE, UnitPicker, unitGone, useUnitPicker } from '@/features/residents/UnitPicker';

const OTHER = 'Other';
// `PackageCreate` (backend app/packages/schemas.py): the tracking pattern, and no control characters in the text.
const TRACKING = /^[A-Za-z0-9]{4}$/;
// Lone surrogates too: Postgres refuses them at flush (the CLAUDE.md lesson).
const INVISIBLE = /[\p{Cc}\p{Cs}]/u;
const VISIBLE_ONLY = 'Use visible characters only.';
const FILE_REFUSED = ['file_not_found', 'invalid_file', 'upload_incomplete'];
const INPUT = 'w-full min-w-0 rounded border px-3 py-2';

type Field = 'unit' | 'recipient' | 'photo' | 'form';
interface Photo {
  status: UploadStatus;
  // Only while `status` is `ready`: a new upload or a failed one never sends the last file (criterion 4).
  fileId: string | null;
}
const NO_PHOTO: Photo = { status: 'idle', fileId: null };

const newKey = () => crypto.randomUUID();

/**
 * The desk's "Log package" panel (P5-03c): unit, recipient, carrier, description, tracking and photo. One
 * `Idempotency-Key` per form (D1): made when the form starts, kept across every failed attempt, replaced after a 201
 * or after the server says the key already logged other details. After a 201 the form starts again with the unit
 * search focused, for the next package.
 */
export function LogPackageForm({ headingId }: { headingId: string }) {
  const buildingId = useBuildingId();
  const picker = useUnitPicker(buildingId);
  const occupants = useUnitOccupants(buildingId, picker.chosen);
  const create = useLogPackage(buildingId);
  const [key, setKey] = useState(newKey);
  const [recipient, setRecipient] = useState<string | null>(null);
  // Any change of unit forgets the recipient, even a return to the unit it was chosen in (R1 F2).
  const [recipientUnit, setRecipientUnit] = useState(picker.chosen);
  if (recipientUnit !== picker.chosen) {
    setRecipientUnit(picker.chosen);
    setRecipient(null);
  }
  const [carrier, setCarrier] = useState<string | null>(null);
  const [otherCarrier, setOtherCarrier] = useState('');
  const [description, setDescription] = useState('');
  const [tracking, setTracking] = useState('');
  const [photo, setPhoto] = useState<Photo>(NO_PHOTO);
  // A new `FileUpload` (no preview, no file) after a reset or "Remove photo".
  const [photoInput, setPhotoInput] = useState(0);
  const [tried, setTried] = useState(false);
  const [logged, setLogged] = useState(false);
  const [error, setError] = useState<{ field: Field; message: string } | null>(null);
  const unitRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const busy = create.isPending;

  // A recipient counts only while the unit's list still has them.
  const recipientId = recipient && occupants.data?.some((o) => o.membership_id === recipient) ? recipient : '';
  const carrierValue = carrier === OTHER ? otherCarrier.trim() : carrier;
  const trackingValue = tracking.trim();
  const problems = {
    unit: picker.chosen === null,
    carrier: carrier === null ? 'Choose a carrier.' : carrier === OTHER && !carrierValue ? 'Type the carrier.' : INVISIBLE.test(otherCarrier) && carrier === OTHER ? VISIBLE_ONLY : null,
    description: INVISIBLE.test(description) ? VISIBLE_ONLY : null,
    tracking: trackingValue && !TRACKING.test(trackingValue) ? 'Use the last 4 letters or digits.' : null,
    photo:
      photo.status === 'uploading'
        ? 'Wait for the photo to finish uploading.'
        : photo.status === 'error'
          ? 'The photo didn’t upload. Retry it or remove it.'
          : null,
  };
  const show = (problem: string | null) => (tried ? problem : null);

  const onPhotoStatus = useCallback(
    (status: UploadStatus) => setPhoto((current) => ({ status, fileId: status === 'ready' ? current.fileId : null })),
    [],
  );

  function removePhoto() {
    setPhoto(NO_PHOTO);
    setPhotoInput((n) => n + 1);
  }

  function startAgain() {
    setKey(newKey());
    picker.clear();
    setRecipient(null);
    setCarrier(null);
    setOtherCarrier('');
    setDescription('');
    setTracking('');
    removePhoto();
    setTried(false);
    setError(null);
    unitRef.current?.focus();
  }

  function failed(err: unknown) {
    const code = err instanceof ApiError ? err.code : null;
    if (err instanceof ApiError && err.status === 409 && code === 'idempotency_key_reused') {
      startAgain();
      setError({
        field: 'form',
        message: 'Your earlier attempt was logged with the details sent then. Check it in “Waiting”; this form is for the next package.',
      });
    } else if (unitGone(err)) {
      picker.unitGone();
      setError({ field: 'unit', message: UNIT_GONE });
    } else if (code === 'invalid_recipient') {
      setRecipient(null);
      void occupants.refetch();
      setError({ field: 'recipient', message: 'That person no longer lives in this unit. Choose again.' });
    } else if (code !== null && FILE_REFUSED.includes(code)) {
      removePhoto();
      setError({ field: 'photo', message: 'The photo can’t be attached. Upload it again.' });
    } else {
      const message =
        rateLimitMessage(err) ??
        (err instanceof ApiError && err.status === 422 ? 'Check the details and try again.' : 'Could not log the package. Your details are kept; try again.');
      setError({ field: 'form', message });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setTried(true);
    setLogged(false);
    setError(null);
    if (picker.chosen === null || carrierValue === null || Object.values(problems).some(Boolean)) return;
    create.mutate(
      {
        key,
        body: {
          unit_id: picker.chosen,
          recipient_membership_id: recipientId || null,
          carrier: carrierValue,
          description: description.trim() || null,
          tracking_last4: trackingValue || null,
          photo_file_id: photo.fileId,
        },
      },
      {
        // A replayed 201 (`Idempotent-Replayed: true`) is the same package: logged too.
        onSuccess: () => {
          startAgain();
          setLogged(true);
        },
        onError: failed,
      },
    );
  }

  const fieldError = (field: Field) =>
    error?.field === field && (
      <p role="alert" className="text-sm text-red-700">
        {error.message}
      </p>
    );
  const hint = (message: string | null, hintId: string) =>
    message && (
      <p id={hintId} className="text-sm text-red-700">
        {message}
      </p>
    );

  return (
    <form aria-labelledby={headingId} noValidate onSubmit={submit} className="grid gap-4 md:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <UnitPicker picker={picker} legend="Choose the unit" label="Unit" busy={busy} missing={tried} searchRef={unitRef} />
        {fieldError('unit')}
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-recipient`} className="text-sm font-medium">
            Recipient
          </label>
          <select
            id={`${id}-recipient`}
            value={recipientId}
            disabled={busy || picker.chosen === null}
            onChange={(event) => setRecipient(event.target.value || null)}
            className="min-h-11 w-full min-w-0 rounded border px-2"
          >
            <option value="">Anyone in the unit</option>
            {occupants.data?.map((occupant) => (
              <option key={occupant.membership_id} value={occupant.membership_id}>
                {occupant.full_name}
              </option>
            ))}
          </select>
          {occupants.isError && (
            <p role="alert" className="text-sm text-red-700">
              {rateLimitMessage(occupants.error) ?? 'Could not load who lives in this unit.'}{' '}
              <button type="button" className="underline" onClick={() => void occupants.refetch()}>
                Try again
              </button>
            </p>
          )}
          {fieldError('recipient')}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <fieldset aria-describedby={show(problems.carrier) ? `${id}-carrier-error` : undefined} className="min-w-0">
          <legend className="mb-1 text-sm font-medium">Carrier</legend>
          <div className="flex flex-wrap gap-2">
            {[...CARRIERS, OTHER].map((name) => (
              <label key={name} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3">
                <input type="radio" name={`${id}-carrier`} checked={carrier === name} disabled={busy} onChange={() => setCarrier(name)} />
                {name}
              </label>
            ))}
          </div>
          {carrier === OTHER && (
            <div className="mt-2 flex flex-col gap-1">
              <label htmlFor={`${id}-other`} className="text-sm font-medium">
                Other carrier
              </label>
              {/* `packages.carrier` varchar(50). */}
              <input id={`${id}-other`} maxLength={50} value={otherCarrier} readOnly={busy} onChange={(event) => setOtherCarrier(event.target.value)} className={INPUT} />
            </div>
          )}
          {hint(show(problems.carrier), `${id}-carrier-error`)}
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-description`} className="text-sm font-medium">
            Description (optional)
          </label>
          {/* `packages.description` varchar(200). */}
          <input
            id={`${id}-description`}
            maxLength={200}
            value={description}
            readOnly={busy}
            onChange={(event) => setDescription(event.target.value)}
            aria-describedby={show(problems.description) ? `${id}-description-error` : undefined}
            className={INPUT}
          />
          {hint(show(problems.description), `${id}-description-error`)}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-tracking`} className="text-sm font-medium">
            Last 4 of tracking (optional)
          </label>
          <input
            id={`${id}-tracking`}
            maxLength={4}
            autoComplete="off"
            value={tracking}
            readOnly={busy}
            onChange={(event) => setTracking(event.target.value)}
            aria-describedby={show(problems.tracking) ? `${id}-tracking-error` : undefined}
            className={`${INPUT} sm:w-32`}
          />
          {hint(show(problems.tracking), `${id}-tracking-error`)}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Photo (optional)</span>
          {/* `purpose` stays constant: `useUpload` keeps a failed form if it changes before Retry (P3-06 R3). */}
          <FileUpload
            key={photoInput}
            purpose="package_photo"
            capture="environment"
            label="Choose photo"
            onUploaded={(fileId) => setPhoto({ status: 'ready', fileId })}
            onStatusChange={onPhotoStatus}
            disabled={busy}
          />
          {photo.status !== 'idle' && photo.status !== 'uploading' && (
            <button type="button" disabled={busy} onClick={removePhoto} className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50">
              Remove photo
            </button>
          )}
          {hint(show(problems.photo), `${id}-photo-error`)}
          {fieldError('photo')}
        </div>
        <button type="submit" disabled={busy} className="min-h-11 self-start rounded bg-blue-700 px-4 text-white disabled:opacity-50">
          Log package
        </button>
        {fieldError('form')}
        <p role="status" aria-live="polite" data-testid="log-status" className="text-sm text-green-800">
          {logged ? 'Logged ✓' : ''}
        </p>
      </div>
    </form>
  );
}
