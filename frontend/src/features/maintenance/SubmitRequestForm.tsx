import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { codePoints, rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import { EmergencyNotice } from '@/features/maintenance/EmergencyNotice';
import { PhotoList, type Photo } from '@/features/maintenance/PhotoList';
import { useCreateMaintenance, type MaintenanceCategory, type MaintenanceRequest, type NewMaintenanceRequest } from '@/features/maintenance/api';
import { CATEGORY_LABEL } from '@/features/maintenance/labels';
import { unitName } from '@/features/onboarding/api';
import { VISIBLE_ONLY, textError, textMessages } from '@/features/packages/PackageDialog';

type Occupancy = components['schemas']['MeOccupancyOut'];
type Field = 'location' | 'common_area' | 'category' | 'description' | 'photos' | 'form';

// `MaintenanceRequestCreate` (backend app/maintenance/schemas.py): both stripped and required, counted in code points.
const DESCRIPTION_MAX = 2000;
const COMMON_AREA_MAX = 120;
const NO_DESCRIPTION = 'Describe the problem.';
const NO_COMMON_AREA = 'Say which common area.';
// A description keeps tabs and line breaks (`multiline_before_strip`); any other control character, or a lone
// surrogate, which Postgres refuses (the CLAUDE.md lesson), is refused.
const INVISIBLE_MULTILINE = /(?![\t\n\r])[\p{Cc}\p{Cs}]/u;
const UNIT_GONE_CODES = ['unit_not_occupied', 'unit_not_found', 'unit_inactive'];
const FILE_REFUSED = ['file_not_found', 'invalid_file', 'upload_incomplete'];
const FAILED = 'Could not send your request. What you typed is kept; try again.';
const INPUT = 'w-full min-w-0 rounded border px-3 py-2';

const newKey = () => crypto.randomUUID();

function descriptionError(value: string): string | null {
  if (INVISIBLE_MULTILINE.test(value)) return VISIBLE_ONLY;
  const length = codePoints(value.trim());
  if (length === 0) return NO_DESCRIPTION;
  return length > DESCRIPTION_MAX ? `Use at most ${DESCRIPTION_MAX} characters.` : null;
}

interface Props {
  buildingId: string;
  /** The caller's current unit here, from `/me`; null offers a common area only (criterion 5). */
  occupancy: Occupancy | null;
  onClose: () => void;
  onSubmitted: (request: MaintenanceRequest) => void;
}

/**
 * The resident's "New request" panel (P6-04b). One `Idempotency-Key` per opened form, kept by every retry (D2); a
 * guard taken before anything else sends one create per press. Every refusal keeps what was typed and the photos, and
 * its message takes focus. The server checks the unit again: one the caller no longer lives in is refused.
 */
export function SubmitRequestForm({ buildingId, occupancy, onClose, onSubmitted }: Props) {
  const create = useCreateMaintenance(buildingId);
  const queryClient = useQueryClient();
  const [key, setKey] = useState(newKey);
  const [chosenLocation, setLocation] = useState<'unit' | 'common_area'>(occupancy ? 'unit' : 'common_area');
  // `/me` can lose the occupancy while the form is open.
  const location = occupancy ? chosenLocation : 'common_area';
  const [commonArea, setCommonArea] = useState('');
  const [category, setCategory] = useState<MaintenanceCategory | ''>('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: Field; message: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const id = useId();

  useEffect(() => {
    mounted.current = true;
    formRef.current?.querySelector<HTMLElement>('input, select')?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  const uploading = photos.some((photo) => photo.status === 'uploading');
  const problems = {
    common_area: location === 'common_area' ? textError(commonArea, COMMON_AREA_MAX, NO_COMMON_AREA) : null,
    category: category === '' ? 'Choose a category.' : null,
    description: descriptionError(description),
    photos: photos.some((photo) => photo.status === 'error')
      ? 'A photo didn’t upload. Retry it or remove it.'
      : photos.some((photo) => photo.status === 'idle')
        ? 'Choose a file for each photo, or remove the empty one.'
        : null,
  };
  const show = (field: keyof typeof problems) => (tried ? problems[field] : null);

  function failed(err: unknown) {
    const code = err instanceof ApiError ? err.code : null;
    if (code === 'idempotency_key_reused') {
      // The key's first attempt was filed with what was sent then; the list is refreshed (`useCreateMaintenance`).
      setKey(newKey());
      setError({ field: 'form', message: 'An earlier attempt of this form was already submitted with the details sent then. Check your list below before sending again.' });
    } else if (code !== null && (UNIT_GONE_CODES.includes(code) || code === 'occupancy_changed')) {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      const message =
        code === 'occupancy_changed'
          ? 'Your unit changed while you were sending. Check where the problem is and send again.'
          : 'You no longer live in this unit. Choose a common area, or ask the building office.';
      setError({ field: 'location', message });
    } else if (code !== null && FILE_REFUSED.includes(code)) {
      setError({ field: 'photos', message: 'A photo can’t be attached. Remove it and add it again.' });
    } else {
      const placed = serverFieldErrors(err, ['common_area', 'category', 'description'] as const, {
        common_area: textMessages(COMMON_AREA_MAX, NO_COMMON_AREA),
        description: textMessages(DESCRIPTION_MAX, NO_DESCRIPTION),
      });
      if (placed) return setError(placed[0]);
      const message = rateLimitMessage(err) ?? (err instanceof ApiError && err.status === 422 ? 'Check the details and try again.' : FAILED);
      setError({ field: 'form', message });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || uploading) return;
    setTried(true);
    setError(null);
    const first = (Object.keys(problems) as (keyof typeof problems)[]).find((field) => problems[field]);
    if (first) {
      formRef.current?.querySelector<HTMLElement>(first === 'photos' ? '[data-photo] button' : `[name="${first}"]`)?.focus();
      return;
    }
    const where: Pick<NewMaintenanceRequest, 'location' | 'unit_id' | 'common_area'> =
      location === 'unit' && occupancy ? { location, unit_id: occupancy.unit_id } : { location: 'common_area', common_area: commonArea.trim() };
    const body: NewMaintenanceRequest = {
      ...where,
      category: category as MaintenanceCategory,
      description: description.trim(),
      photo_file_ids: photos.map((photo) => photo.fileId!),
    };
    inFlight.current = true;
    setBusy(true);
    // The submit is about to be disabled, which drops focus to <body> in a browser: the status line, which stays,
    // holds it until the outcome or a message takes it.
    statusRef.current?.focus();
    let made;
    try {
      made = await create.mutateAsync({ key, body });
    } catch (err) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      failed(err);
      return;
    }
    if (mounted.current) onSubmitted(made);
  }

  const alert = (field: Field) =>
    error?.field === field && (
      <p ref={alertRef} role="alert" tabIndex={-1} className="text-sm text-red-700">
        {error.message}
      </p>
    );
  const hint = (field: keyof typeof problems) =>
    show(field) && (
      <p id={`${id}-${field}-error`} className="text-sm text-red-700">
        {show(field)}
      </p>
    );
  const describedBy = (field: keyof typeof problems, ...others: string[]) =>
    [...(show(field) ? [`${id}-${field}-error`] : []), ...others].join(' ') || undefined;

  return (
    <form ref={formRef} aria-labelledby={`${id}-heading`} noValidate onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-4 rounded border bg-white p-4 [overflow-wrap:anywhere]">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        New maintenance request
      </h2>
      {occupancy ? (
        <fieldset className="min-w-0">
          <legend className="mb-1 text-sm font-medium">Where is the problem?</legend>
          <div className="flex flex-wrap gap-2">
            <label className="flex min-h-11 items-center gap-2 rounded border px-3">
              <input type="radio" name={`${id}-location`} checked={location === 'unit'} disabled={busy} onChange={() => setLocation('unit')} />
              My unit, {unitName(occupancy.tower, occupancy.unit_label)}
            </label>
            <label className="flex min-h-11 items-center gap-2 rounded border px-3">
              <input type="radio" name={`${id}-location`} checked={location === 'common_area'} disabled={busy} onChange={() => setLocation('common_area')} />
              A common area
            </label>
          </div>
        </fieldset>
      ) : (
        <p className="text-sm text-slate-700">You have no unit on file in this building, so you can report a common-area problem only.</p>
      )}
      {alert('location')}
      {location === 'common_area' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-common-area`} className="text-sm font-medium">
            Which common area?
          </label>
          <input
            id={`${id}-common-area`}
            name="common_area"
            maxLength={2 * COMMON_AREA_MAX}
            value={commonArea}
            readOnly={busy}
            onChange={(event) => setCommonArea(event.target.value)}
            aria-describedby={describedBy('common_area')}
            className={INPUT}
          />
          {hint('common_area')}
          {alert('common_area')}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-category`} className="text-sm font-medium">
          Category
        </label>
        <select
          id={`${id}-category`}
          name="category"
          value={category}
          disabled={busy}
          onChange={(event) => setCategory(event.target.value as MaintenanceCategory | '')}
          aria-describedby={describedBy('category')}
          className="min-h-11 w-full min-w-0 rounded border px-2"
        >
          <option value="">Choose a category</option>
          {(Object.keys(CATEGORY_LABEL) as MaintenanceCategory[]).map((value) => (
            <option key={value} value={value}>
              {CATEGORY_LABEL[value]}
            </option>
          ))}
        </select>
        {hint('category')}
        {alert('category')}
      </div>
      {category === 'emergency' && <EmergencyNotice />}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-description`} className="text-sm font-medium">
          Description
        </label>
        <textarea
          id={`${id}-description`}
          name="description"
          rows={5}
          maxLength={2 * DESCRIPTION_MAX}
          value={description}
          readOnly={busy}
          onChange={(event) => setDescription(event.target.value)}
          aria-describedby={describedBy('description', `${id}-count`)}
          className={INPUT}
        />
        <p id={`${id}-count`} className="text-xs text-slate-600">
          {codePoints(description.trim())} of {DESCRIPTION_MAX} characters
        </p>
        {hint('description')}
        {alert('description')}
      </div>
      <PhotoList photos={photos} setPhotos={setPhotos} busy={busy} hintId={`${id}-photos-error`} hint={show('photos')}>
        {alert('photos')}
      </PhotoList>
      {uploading && (
        <p id={`${id}-uploading`} className="text-sm text-slate-700">
          Wait for the photos to finish uploading.
        </p>
      )}
      {alert('form')}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || uploading}
          aria-describedby={uploading ? `${id}-uploading` : undefined}
          className="min-h-11 rounded bg-blue-700 px-4 text-white disabled:opacity-50"
        >
          Submit request
        </button>
        <button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded border px-4 disabled:opacity-50">
          Close
        </button>
      </div>
      <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="text-sm text-slate-700">
        {busy ? 'Sending…' : ''}
      </p>
    </form>
  );
}
