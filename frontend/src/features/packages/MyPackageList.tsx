import { useRef } from 'react';
import { Link } from 'react-router-dom';

import { useBuildingId } from '@/app/BuildingProvider';
import { pagePath } from '@/app/pages';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { PrivateImage } from '@/features/files/PrivateImage';
import { useFocusedRetry } from '@/features/lists/useFocusedRetry';
import { useLoadMore } from '@/features/lists/useLoadMore';
import { useMyPackages, type MyList, type Package } from '@/features/packages/api';

const TEXT: Record<MyList, { heading: string; name: string; empty: string; failed: string }> = {
  waiting: {
    heading: 'Waiting for you',
    name: 'Waiting for you',
    empty: 'No packages are waiting for you.',
    failed: 'Could not load your packages.',
  },
  history: {
    heading: 'History',
    name: 'Package history',
    empty: 'No package history yet.',
    failed: 'Could not load your package history.',
  },
};

/** "Package photo: UPS", the photo's alt everywhere on the resident page (criterion 5). */
export const photoAlt = (item: Package) => `Package photo: ${item.carrier}`;

/** What happened to a package and when: "Arrived …", "Picked up …" or "Returned …", in building time. */
export function packageMoment(item: Package): { label: string; at: string } {
  if (item.status === 'picked_up' && item.picked_up_at) return { label: 'Picked up', at: item.picked_up_at };
  if (item.status === 'returned' && item.returned_at) return { label: 'Returned', at: item.returned_at };
  return { label: 'Arrived', at: item.received_at };
}

interface Props {
  list: MyList;
  /** False until the page may ask for the list (it waits for the waiting count, round 2 F1). */
  enabled: boolean;
  time: Intl.DateTimeFormat | undefined;
  /** A Details link was followed: the page returns focus to it when the dialog closes. */
  onOpen: (link: HTMLAnchorElement) => void;
}

/**
 * One of the resident's lists (P5-04): "Waiting for you" as cards with the photo and where to collect it, or "History"
 * as rows saying how each package ended. Paged with Load more; each item links to its detail dialog.
 */
export function MyPackageList({ list, enabled, time, onOpen }: Props) {
  const query = useMyPackages(useBuildingId(), list, enabled);
  const text = TEXT[list];
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = () => headingRef.current?.focus();
  const more = useLoadMore(query, focusHeading);
  const { retryRef, retry } = useFocusedRetry(query, focusHeading);

  let body;
  if (query.isPending) body = <p role="status">Loading packages…</p>;
  else if (query.isError && !query.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(query.error) ?? text.failed}{' '}
        <button type="button" ref={retryRef} className="underline" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  const shown =
    query.data &&
    (items.length === 0 ? (
      <p>{text.empty}</p>
    ) : (
      <ul ref={more.listRef} aria-label={text.name} className="flex flex-col gap-3">
        {items.map((item) => (
          <Item key={item.id} item={item} card={list === 'waiting'} time={time} onOpen={onOpen} />
        ))}
      </ul>
    ));

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
        {text.heading}
      </h2>
      {body}
      {shown}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-red-700">
          {rateLimitMessage(query.error) ?? 'Could not load more packages.'}
        </p>
      )}
      {query.hasNextPage && !query.isRefetchError && (
        // As the desk's list: not while any fetch is out, nor after a failed refresh.
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
    </section>
  );
}

interface ItemProps {
  item: Package;
  card: boolean;
  time: Intl.DateTimeFormat | undefined;
  onOpen: (link: HTMLAnchorElement) => void;
}

function Item({ item, card, time, onOpen }: ItemProps) {
  const moment = packageMoment(item);
  const when = time?.format(new Date(moment.at));
  const thumbnail = 'h-20 w-20 shrink-0 rounded object-cover';
  return (
    <li tabIndex={-1} className="flex gap-3 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      {card &&
        (item.photo_file_id ? (
          <PrivateImage fileId={item.photo_file_id} alt={photoAlt(item)} className={thumbnail} />
        ) : (
          <div className={`${thumbnail} flex items-center justify-center bg-slate-100 text-xs text-slate-600`}>No photo</div>
        ))}
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">{item.carrier}</h3>
        {item.description && <p className="text-sm text-slate-700">{item.description}</p>}
        <p className="text-sm text-slate-700">
          {moment.label} <time dateTime={moment.at}>{when}</time>
        </p>
        {card && <p className="text-sm font-medium">Pick up at the front desk</p>}
        <Link
          to={`${pagePath('Packages')}/${item.id}`}
          state={{ fromList: true }}
          aria-label={`Details: ${item.carrier} package, ${moment.label.toLowerCase()} ${when ?? ''}`.trim()}
          onClick={(event) => onOpen(event.currentTarget)}
          className="mt-1 inline-flex min-h-11 items-center text-sm underline"
        >
          Details
        </Link>
      </div>
    </li>
  );
}
