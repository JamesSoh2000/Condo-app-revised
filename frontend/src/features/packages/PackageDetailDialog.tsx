import { useEffect, useId, useRef } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { PrivateImage } from '@/features/files/PrivateImage';
import { unitName } from '@/features/onboarding/api';
import { usePackage, type Package } from '@/features/packages/api';
import { packageMoment, photoAlt } from '@/features/packages/MyPackageList';
import { Modal } from '@/features/residents/Modal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<Package['status'], string> = {
  received: 'Waiting at the front desk',
  picked_up: 'Picked up',
  returned: 'Returned to the carrier',
};

interface Props {
  packageId: string;
  time: Intl.DateTimeFormat | undefined;
  onClose: () => void;
}

/**
 * `/packages/<id>` (P5-04 criteria 3 and 6): one package from `packages_get`, over the page's lists. The API answers
 * 404 for another resident's package, another building's and none at all, so they all show the same "Package not
 * found"; so does an id that isn't a UUID, which isn't sent.
 */
export function PackageDetailDialog({ packageId, time, onClose }: Props) {
  const valid = UUID.test(packageId);
  const query = usePackage(useBuildingId(), packageId, valid);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const notFound = !valid || (query.error instanceof ApiError && query.error.status === 404);
  // A failed request hides an answer cached from before, so an old status never reads as current (review round 1,
  // Codex F2).
  const item = notFound || query.isError ? undefined : query.data;
  const title = notFound ? 'Package not found' : item ? `${item.carrier} package` : 'Package';

  let body;
  if (notFound) body = <p className="mt-2">There is no package at this address.</p>;
  else if (item) body = <Detail item={item} time={time} />;
  else if (query.isError) {
    body = (
      <div role="alert" className="mt-2 text-sm text-red-700">
        {rateLimitMessage(query.error) ?? 'Could not load the package.'}{' '}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  } else body = <p role="status" className="mt-2">Loading package…</p>;

  return (
    <Modal labelledBy={titleId} busy={false} onEscape={onClose} dialogRef={dialogRef}>
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

function Detail({ item, time }: { item: Package; time: Intl.DateTimeFormat | undefined }) {
  const moment = packageMoment(item);
  const at = (value: string) => <time dateTime={value}>{time?.format(new Date(value))}</time>;
  return (
    <>
      {item.photo_file_id ? (
        <PrivateImage fileId={item.photo_file_id} alt={photoAlt(item)} className="mt-3 h-48 w-full rounded object-cover" />
      ) : (
        <div className="mt-3 flex h-24 items-center justify-center rounded bg-slate-100 text-sm text-slate-600">No photo</div>
      )}
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium">Status</dt>
        <dd>{STATUS[item.status]}</dd>
        <dt className="font-medium">Unit</dt>
        <dd>{unitName(item.unit_tower, item.unit_label)}</dd>
        {item.description && (
          <>
            <dt className="font-medium">Description</dt>
            <dd>{item.description}</dd>
          </>
        )}
        <dt className="font-medium">Arrived</dt>
        <dd>{at(item.received_at)}</dd>
        {moment.label !== 'Arrived' && (
          <>
            <dt className="font-medium">{moment.label}</dt>
            <dd>{at(moment.at)}</dd>
          </>
        )}
      </dl>
      {item.status === 'received' && <p className="mt-3 text-sm font-medium">Pick up at the front desk.</p>}
    </>
  );
}
