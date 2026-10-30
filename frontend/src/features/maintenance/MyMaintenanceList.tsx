import { Link } from 'react-router-dom';

import { pagePath } from '@/app/pages';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useFocusedRetry } from '@/features/lists/useFocusedRetry';
import { useLoadMore } from '@/features/lists/useLoadMore';
import { useMaintenanceRequests, type MaintenanceRequest } from '@/features/maintenance/api';
import { CATEGORY_LABEL, STATUS_LABEL, firstLine, requestLocation } from '@/features/maintenance/labels';

interface Props {
  buildingId: string;
  time: Intl.DateTimeFormat | undefined;
  /** Where focus goes when "Load more" added no card (`useLoadMore`). */
  focusHeading: () => void;
  /** A Details link was followed: the page returns focus to it when the view closes (P6-04c criterion 7a). */
  onOpen: (link: HTMLAnchorElement) => void;
}

/**
 * The resident's requests (P6-04a): one card each, in the API's order, paged with "Load more". Every item the API
 * returns is shown: `visible_maintenance` already decided which are the caller's, a co-occupant's included.
 */
export function MyMaintenanceList({ buildingId, time, focusHeading, onOpen }: Props) {
  const query = useMaintenanceRequests(buildingId);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const more = useLoadMore(query, focusHeading);
  const { retryRef, retry } = useFocusedRetry(query, focusHeading);

  let body;
  if (query.isPending) body = <p role="status">Loading requests…</p>;
  else if (query.isError && !query.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(query.error) ?? 'Could not load your requests.'}{' '}
        <button type="button" ref={retryRef} className="underline" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  const shown =
    query.data &&
    (items.length === 0 ? (
      <p>You haven’t submitted any requests.</p>
    ) : (
      <ul ref={more.listRef} aria-label="Your maintenance requests" className="flex flex-col gap-3">
        {items.map((item) => (
          <Card key={item.id} item={item} time={time} onOpen={onOpen} />
        ))}
      </ul>
    ));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {body}
      {shown}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-red-700">
          {rateLimitMessage(query.error) ?? 'Could not load more requests.'}
        </p>
      )}
      {query.hasNextPage && !query.isRefetchError && (
        // As the packages lists: not while any fetch is out, nor after a failed refresh.
        <button
          type="button"
          ref={more.buttonRef}
          disabled={query.isFetching}
          onClick={more.onClick}
          className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50"
        >
          Load more
        </button>
      )}
    </div>
  );
}

interface CardProps {
  item: MaintenanceRequest;
  time: Intl.DateTimeFormat | undefined;
  onOpen: (link: HTMLAnchorElement) => void;
}

function Card({ item, time, onOpen }: CardProps) {
  const photos = item.photo_file_ids.length;
  const submitted = time?.format(new Date(item.submitted_at));
  return (
    <li tabIndex={-1} className="flex flex-col gap-1 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="min-w-0 font-medium">{CATEGORY_LABEL[item.category]}</h3>
        <p className="text-sm font-medium">{STATUS_LABEL[item.status]}</p>
      </div>
      <p className="text-sm text-slate-700">{requestLocation(item)}</p>
      <p className="text-sm">{firstLine(item.description)}</p>
      <p className="text-sm text-slate-700">
        Submitted <time dateTime={item.submitted_at}>{submitted}</time>
        {photos > 0 && ` · ${photos} ${photos === 1 ? 'photo' : 'photos'}`}
      </p>
      <Link
        to={`${pagePath('Maintenance')}/${item.id}`}
        state={{ fromList: true }}
        aria-label={`Details: ${CATEGORY_LABEL[item.category]}, submitted ${submitted ?? ''}`.trim()}
        onClick={(event) => onOpen(event.currentTarget)}
        className="inline-flex min-h-11 items-center self-start text-sm underline"
      >
        Details
      </Link>
    </li>
  );
}
