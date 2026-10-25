import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useBuilding, useBuildingId } from '@/app/BuildingProvider';
import { pagePath } from '@/app/pages';
import { noticeFeedKey, useNoticeSummary } from '@/features/notices/api';
import { NoticeDetailDialog } from '@/features/notices/NoticeDetailDialog';
import { NoticeList } from '@/features/notices/NoticeList';
import { buildingTime } from '@/features/packages/time';

/**
 * `/notices` (P6-02a), for every member: the building's live notices. `/notices/<id>`, the notifications' and the
 * banner's link, shows one notice in a dialog over the feed (P6-02b). Keyed by building, so nothing of one building's
 * feed shows in another (criterion 10).
 */
export function NoticesPage() {
  const buildingId = useBuildingId();
  return <Notices key={buildingId} buildingId={buildingId} />;
}

function Notices({ buildingId }: { buildingId: string }) {
  const { noticeId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Under the page's guards, which render it only once the building has loaded.
  const time = buildingTime(useBuilding({ passive: true }).data);

  // As `MyPackagesPage` (P5-04 criterion 9 and its review rounds 1–2): the feed doesn't poll, so when the badge's polled
  // count moves it is asked again, cancelled first, since a request already out may have been read before the change.
  // It starts only once there is a count (cached by the nav, or this mount's first answer), so it is never older than
  // the count it is compared with; if the count fails it starts anyway, and its first answer then asks it again.
  const summary = useNoticeSummary(buildingId);
  const unread = summary.data?.unread;
  const ready = unread !== undefined || summary.isError;
  const blind = useRef(false);
  const seen = useRef(unread);
  useEffect(() => {
    if (unread === undefined) {
      blind.current ||= ready;
      return;
    }
    if (seen.current === undefined ? blind.current : seen.current !== unread) {
      const filters = { queryKey: noticeFeedKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    }
    seen.current = unread;
  }, [unread, ready, buildingId, queryClient]);

  // As `MyPackagesPage`: focus goes back to the heading when the dialog closes, and Close goes back to the feed it
  // came from, or, for a link from elsewhere (the bell, the banner, a bookmark), to the feed in its place.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(noticeId !== undefined);
  useEffect(() => {
    if (wasOpen.current && noticeId === undefined) headingRef.current?.focus();
    wasOpen.current = noticeId !== undefined;
  }, [noticeId]);
  const close = () => {
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else navigate(pagePath('Notices'), { replace: true });
  };

  return (
    <section>
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold">
        Notices
      </h1>
      <NoticeList enabled={ready} time={time} onFocusLost={() => headingRef.current?.focus()} />
      {noticeId !== undefined && <NoticeDetailDialog key={noticeId} noticeId={noticeId} time={time} onClose={close} />}
    </section>
  );
}
