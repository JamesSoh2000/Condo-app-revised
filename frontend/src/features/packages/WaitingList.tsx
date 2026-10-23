import { useId, useState } from 'react';

import { useBuilding, useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { PrivateImage } from '@/features/files/PrivateImage';
import { unitName } from '@/features/onboarding/api';
import { CARRIERS, useWaitingPackages, type Package } from '@/features/packages/api';
import { packageAge, useNow } from '@/features/packages/time';
import { UnitPicker, useUnitPicker } from '@/features/residents/UnitPicker';

const THUMBNAIL = 'h-20 w-20 shrink-0 rounded object-cover';

/**
 * The desk's "Waiting" list (P5-03b): the received packages, searched by unit (the residents `UnitPicker`, D1) and
 * filtered by carrier (D2), each with its photo, unit, recipient, carrier and age. Times are the building's, not the
 * device's. Asked again on mount, focus and Refresh, never polled (D3).
 */
export function WaitingList() {
  const buildingId = useBuildingId();
  // Under the page's guards, which render it only once the building has loaded.
  const building = useBuilding({ passive: true }).data;
  const picker = useUnitPicker(buildingId);
  const [carrier, setCarrier] = useState<string | null>(null);
  const filters = { unitId: picker.chosen, carrier };
  const waiting = useWaitingPackages(buildingId, filters);
  const now = useNow();
  const id = useId();

  const time = building && new Intl.DateTimeFormat(building.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: building.timezone });
  const items = waiting.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = filters.unitId !== null || filters.carrier !== null;

  let body;
  if (waiting.isPending) body = <p role="status">Loading packages…</p>;
  else if (waiting.isError && !waiting.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(waiting.error) ?? (waiting.data ? 'Could not refresh the packages.' : 'Could not load the packages.')}{' '}
        <button type="button" className="underline" onClick={() => void waiting.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const list =
    waiting.data && items.length === 0 ? (
      <p>{filtered ? 'No waiting packages match.' : 'No packages are waiting.'}</p>
    ) : (
      waiting.data && (
        <ul aria-label="Waiting packages" className="flex flex-col gap-3">
          {items.map((item) => (
            <Row key={item.id} item={item} now={now} time={time} />
          ))}
        </ul>
      )
    );

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <UnitPicker picker={picker} legend="Show packages for" busy={false} missing={false} />
        {(picker.search || picker.chosen) && (
          <button type="button" onClick={picker.clear} className="min-h-11 self-start rounded border px-4 text-sm">
            All units
          </button>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-carrier`} className="text-sm font-medium">
            Carrier
          </label>
          <select
            id={`${id}-carrier`}
            value={carrier ?? ''}
            onChange={(event) => setCarrier(event.target.value || null)}
            className="min-h-11 rounded border px-2"
          >
            <option value="">All carriers</option>
            {CARRIERS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Waiting</h2>
          <button
            type="button"
            disabled={waiting.isFetching}
            onClick={() => void waiting.refetch()}
            className="min-h-11 rounded border px-4 text-sm disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
        {body}
        {list}
        {waiting.isFetchNextPageError && (
          <p role="alert" className="text-sm text-red-700">
            Could not load more packages.
          </p>
        )}
        {waiting.hasNextPage && !waiting.isRefetchError && (
          // As the members list: not while any fetch is out, nor after a failed refresh (P4-08b review rounds 2, 3).
          <button
            type="button"
            disabled={waiting.isFetching}
            onClick={() => void waiting.fetchNextPage({ cancelRefetch: false })}
            className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50"
          >
            Show more
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ item, now, time }: { item: Package; now: number; time: Intl.DateTimeFormat | undefined }) {
  const unit = unitName(item.unit_tower, item.unit_label);
  return (
    <li className="flex gap-3 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      {item.photo_file_id ? (
        <PrivateImage fileId={item.photo_file_id} alt={`Package photo for unit ${unit}`} className={THUMBNAIL} />
      ) : (
        <div className={`${THUMBNAIL} flex items-center justify-center bg-slate-100 text-xs text-slate-600`}>No photo</div>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">Unit {unit}</h3>
        {/* Null for a package addressed to the unit: staff always get the recipient's name (P5-03a). */}
        <p className="text-sm">{item.recipient_name ?? 'Anyone in the unit'}</p>
        <p className="text-sm text-slate-700">
          {item.carrier}
          {item.description && ` · ${item.description}`}
        </p>
        <p className="text-sm text-slate-700">
          {packageAge(item.received_at, now)} · <time dateTime={item.received_at}>{time?.format(new Date(item.received_at))}</time>
        </p>
      </div>
    </li>
  );
}
