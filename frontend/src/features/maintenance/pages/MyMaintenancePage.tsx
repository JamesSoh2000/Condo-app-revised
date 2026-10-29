import { useRef } from 'react';

import { useBuilding, useBuildingDenied, useBuildingId } from '@/app/BuildingProvider';
import { MyMaintenanceList } from '@/features/maintenance/MyMaintenanceList';
import { buildingTime } from '@/features/packages/time';

/**
 * `/maintenance` (P6-04a), for residents: their maintenance requests. The route also takes `/maintenance/<id>`, the
 * notifications' link, so P6-04c's view of one request mounts on this page; until then it shows the list. Keyed by
 * building, so nothing of one building's list shows in another.
 */
export function MyMaintenancePage() {
  const buildingId = useBuildingId();
  return <Maintenance key={buildingId} buildingId={buildingId} />;
}

function Maintenance({ buildingId }: { buildingId: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Under the page's guards, which render it only once the building has loaded; a denied building shows nothing of it.
  const building = useBuilding({ passive: true }).data;
  const time = useBuildingDenied() ? undefined : buildingTime(building);

  return (
    <section>
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold">
        Maintenance requests
      </h1>
      <div className="mt-4">
        <MyMaintenanceList buildingId={buildingId} time={time} focusHeading={() => headingRef.current?.focus()} />
      </div>
    </section>
  );
}
