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
  const waiting = usePackageSummary(buildingId).data?.waiting;
  const seen = useRef(waiting);
  useEffect(() => {
    if (waiting === undefined) return;
    if (seen.current !== undefined && seen.current !== waiting) void queryClient.invalidateQueries({ queryKey: myPackagesKey(buildingId) });
    seen.current = waiting;
  }, [waiting, buildingId, queryClient]);

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
        <MyPackageList list="waiting" time={time} onOpen={onOpen} />
        <MyPackageList list="history" time={time} onOpen={onOpen} />
      </div>
      {packageId !== undefined && <PackageDetailDialog key={packageId} packageId={packageId} time={time} onClose={close} />}
    </section>
  );
}
