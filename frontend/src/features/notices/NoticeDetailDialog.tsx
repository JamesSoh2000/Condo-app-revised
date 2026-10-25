import { useEffect, useId, useRef } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useMarkReadOnce, useNotice, type Notice } from '@/features/notices/api';
import { NoticeAttachment } from '@/features/notices/NoticeAttachment';
import { NoticeBody } from '@/features/notices/NoticeBody';
import { NoticeLabels, NoticeTimes } from '@/features/notices/NoticeList';
import { Modal } from '@/features/residents/Modal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Props {
  noticeId: string;
  time: Intl.DateTimeFormat | undefined;
  onClose: () => void;
}

/**
 * `/notices/<id>` (P6-02b criteria A and B): one notice from `notices_get`, over the feed, as `PackageDetailDialog`.
 * The API answers 404 for a notice the caller may not see (a resident's draft, archived or expired one), another
 * building's and none at all, so they all show the same "Notice not found"; so does an id that isn't a UUID, which
 * isn't sent. Opening it marks nothing read; its button does (D3).
 */
export function NoticeDetailDialog({ noticeId, time, onClose }: Props) {
  const valid = UUID.test(noticeId);
  const query = useNotice(useBuildingId(), noticeId, valid);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const notFound = !valid || (query.error instanceof ApiError && query.error.status === 404);
  // A failed request hides an answer cached from before, so an old copy never reads as current (as packages).
  const item = notFound || query.isError ? undefined : query.data;
  const title = notFound ? 'Notice not found' : (item?.title ?? 'Notice');

  let body;
  if (notFound) body = <p className="mt-2">There is no notice at this address.</p>;
  else if (item) body = <Detail item={item} time={time} />;
  else if (query.isError) {
    body = (
      <div role="alert" className="mt-2 text-sm text-red-700">
        {rateLimitMessage(query.error) ?? 'Could not load the notice.'}{' '}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  } else body = <p role="status" className="mt-2">Loading notice…</p>;

  return (
    <Modal labelledBy={titleId} busy={false} onEscape={onClose} dialogRef={dialogRef}>
      <h2 id={titleId} className="text-lg font-semibold [overflow-wrap:anywhere]">
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

function Detail({ item, time }: { item: Notice; time: Intl.DateTimeFormat | undefined }) {
  const { read, markRead } = useMarkReadOnce(useBuildingId());
  // A 404 means the notice left while open: the read's refresh then shows "Notice not found".
  const failed = read.isError && !(read.error instanceof ApiError && read.error.status === 404);
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <NoticeLabels item={item} />
      </div>
      <NoticeTimes item={item} time={time} />
      <NoticeBody markdown={item.body} />
      {item.attachment_file_id && <NoticeAttachment fileId={item.attachment_file_id} />}
      {item.read_at === null && (
        <button
          type="button"
          disabled={read.isPending}
          onClick={() => markRead(item.id)}
          className="mt-3 min-h-11 rounded border px-4 text-sm disabled:opacity-50"
        >
          Mark as read
        </button>
      )}
      {failed && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {rateLimitMessage(read.error) ?? 'Could not mark the notice read.'}
        </p>
      )}
    </div>
  );
}
