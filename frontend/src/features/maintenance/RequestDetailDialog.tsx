import { useEffect, useId, useRef } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingContext, useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { PrivateImage } from '@/features/files/PrivateImage';
import { EmergencyNotice } from '@/features/maintenance/EmergencyNotice';
import {
  useMaintenanceComments,
  useMaintenanceRequest,
  useMaintenanceStatusEvents,
  type MaintenanceRequest,
} from '@/features/maintenance/api';
import { CATEGORY_LABEL, STATUS_LABEL, requestLocation } from '@/features/maintenance/labels';
import { Timeline } from '@/features/maintenance/Timeline';
import { Modal } from '@/features/residents/Modal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

interface Props {
  requestId: string;
  time: Intl.DateTimeFormat | undefined;
  onClose: () => void;
}

/**
 * `<path>/<id>` (P6-04c): one maintenance request over the list, as `PackageDetailDialog`, with its timeline. The API
 * answers 404 for a request the caller may not see, another building's and none at all, so they all show the same
 * "Request not found"; so does an id that isn't a UUID, which isn't sent. The timeline's two reads start only once the
 * request has loaded (criterion 5), and a 404 from either (the request left while open) is not found too.
 */
export function RequestDetailDialog({ requestId, time, onClose }: Props) {
  const buildingId = useBuildingId();
  const roles = useBuildingContext().active.find((one) => one.building.id === buildingId)?.roles ?? [];
  // Who reads as staff here (P6-03d `sees_internal_comments`); the server decides, this only keys the cache.
  const staff = roles.includes('security') || roles.includes('property_management');
  const valid = UUID.test(requestId);
  const query = useMaintenanceRequest(buildingId, requestId, staff, valid);
  // Read here for their 404 only; the timeline reads them again (the same queries) to show them.
  const events = useMaintenanceStatusEvents(buildingId, requestId, staff, query.isSuccess);
  const comments = useMaintenanceComments(buildingId, requestId, staff, query.isSuccess);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  // A read that fails or answers 404 replaces what was shown, and the entry or button that had focus with it; focus
  // then falls to <body>, out of the dialog's Escape and Tab trap. After every render it is put back on the dialog
  // (review round 2 F1). Any read's change re-renders this component: it observes all three.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) dialogRef.current?.focus();
  });

  const notFound = !valid || [query, events, comments].some((read) => isNotFound(read.error));
  // A failed request hides an answer cached from before, so an old status never reads as current (as packages).
  const item = notFound || query.isError ? undefined : query.data;
  const title = notFound ? 'Request not found' : item ? `${CATEGORY_LABEL[item.category]} request` : 'Maintenance request';

  let body;
  if (notFound) body = <p className="mt-2">There is no request at this address.</p>;
  else if (item) {
    body = (
      <>
        <Detail item={item} time={time} />
        <h3 className="mt-4 font-semibold">Timeline</h3>
        <Timeline request={item} staff={staff} time={time} focusDialog={() => dialogRef.current?.focus()} />
      </>
    );
  } else if (query.isError) {
    body = (
      <div role="alert" className="mt-2 text-sm text-red-700">
        {rateLimitMessage(query.error) ?? 'Could not load the request.'}{' '}
        <button
          type="button"
          className="underline"
          onClick={() => {
            // The button goes when the request loads: focus would drop to <body> (known failure cases).
            dialogRef.current?.focus();
            void query.refetch();
          }}
        >
          Try again
        </button>
      </div>
    );
  } else body = <p role="status" className="mt-2">Loading request…</p>;

  return (
    <Modal labelledBy={titleId} busy={false} onEscape={onClose} dialogRef={dialogRef} wide>
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      {body}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className="min-h-11 rounded border px-4">
          Close
        </button>
      </div>
    </Modal>
  );
}

function Detail({ item, time }: { item: MaintenanceRequest; time: Intl.DateTimeFormat | undefined }) {
  const photos = item.photo_file_ids;
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-slate-700">Status</dt>
        <dd className="font-medium">{STATUS_LABEL[item.status]}</dd>
        <dt className="text-slate-700">Location</dt>
        <dd>{requestLocation(item)}</dd>
        <dt className="text-slate-700">Submitted</dt>
        <dd>
          <time dateTime={item.submitted_at}>{time?.format(new Date(item.submitted_at))}</time>
        </dd>
        {item.requester_name !== null && (
          <>
            <dt className="text-slate-700">Requested by</dt>
            <dd>{item.requester_name}</dd>
          </>
        )}
      </dl>
      {item.category === 'emergency' && <EmergencyNotice submitted phone={item.emergency_phone} />}
      {/* Text, never HTML: React escapes it; line breaks kept (criterion 1c). */}
      <p className="whitespace-pre-wrap">{item.description}</p>
      {photos.length > 0 && (
        <ul aria-label="Photos" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((fileId, index) => (
            <li key={fileId}>
              <PrivateImage fileId={fileId} alt={`Photo ${index + 1} of ${photos.length}`} className="aspect-square w-full rounded object-cover" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
