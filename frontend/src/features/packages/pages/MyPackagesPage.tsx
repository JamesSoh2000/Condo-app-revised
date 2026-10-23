import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useBuilding, useBuildingId } from '@/app/BuildingProvider';
import { pagePath } from '@/app/pages';
import { myPackagesKey, usePackageSummary } from '@/features/packages/api';
import { MyPackageList } from '@/features/packages/MyPackageList';
import { PackageDetailDialog } from '@/features/packages/PackageDetailDialog';
import { buildingTime } from '@/features/packages/time';

/**
 * `/packages` (P5-04), for residents: the packages waiting for them and their history, and at `/packages/<id>` one
 * package in a dialog over them (the `package.arrived` notification's link). Keyed by building, so nothing of one
 * building's lists shows in another.
 */
export function MyPackagesPage() {
  const buildingId = useBuildingId();
  return <Packages key={buildingId} buildingId={buildingId} />;
}

function Packages({ buildingId }: { buildingId: string }) {
  const { packageId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Under the page's guards, which render it only once the building has loaded.
  const time = buildingTime(useBuilding({ passive: true }).data);

  // The lists don't poll (ADR-0012); when the badge's polled count moves, they are asked again (criterion 9).
  // Cancelled first, as after a desk mutation: a request already out, even a list's first, may have been read before
  // the change, and invalidating alone would keep it (review round 1, Codex F1). They start only once there is a
  // count (cached by the nav, or this mount's first answer), so no list is older than the count it is compared with
  // (review round 2, Codex F1); if the count fails they start anyway, and its first answer then asks them again.
  const summary = usePackageSummary(buildingId);
  const waiting = summary.data?.waiting;
  const ready = waiting !== undefined || summary.isError;
  const blind = useRef(false);
  const seen = useRef(waiting);
  useEffect(() => {
    if (waiting === undefined) {
      blind.current ||= ready;
      return;
    }
    if (seen.current === undefined ? blind.current : seen.current !== waiting) {
      const filters = { queryKey: myPackagesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    }
    seen.current = waiting;
  }, [waiting, ready, buildingId, queryClient]);

  // Focus goes back to the Details link that opened the dialog, or to the heading (a deep link, or a list that
  // refreshed the link away).
  const opener = useRef<HTMLAnchorElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(packageId !== undefined);
  useEffect(() => {
    if (wasOpen.current && packageId === undefined) (opener.current?.isConnected ? opener.current : headingRef.current)?.focus();
    wasOpen.current = packageId !== undefined;
  }, [packageId]);

  // Back to the list it came from, or, for a link from elsewhere (the bell, a bookmark), to the list in its place.
  const close = () => {
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else navigate(pagePath('Packages'), { replace: true });
  };
  const onOpen = (link: HTMLAnchorElement) => {
    opener.current = link;
  };

  return (
    <section>
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold">
        My packages
      </h1>
      <div className="mt-4 flex flex-col gap-8">
        <MyPackageList list="waiting" enabled={ready} time={time} onOpen={onOpen} />
        <MyPackageList list="history" enabled={ready} time={time} onOpen={onOpen} />
      </div>
      {packageId !== undefined && <PackageDetailDialog key={packageId} packageId={packageId} time={time} onClose={close} />}
    </section>
  );
}
