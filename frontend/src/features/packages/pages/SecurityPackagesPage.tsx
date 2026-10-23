import { useBuildingId } from '@/app/BuildingProvider';
import { WaitingList } from '@/features/packages/WaitingList';

/**
 * `/security/packages` (P5-03b), for security and property management: the packages waiting at the desk. Keyed by
 * building, so nothing of one building's filters or list shows in another. P5-03c adds logging, P5-03d pickup and
 * return.
 */
export function SecurityPackagesPage() {
  const buildingId = useBuildingId();
  return (
    <section>
      <h1 className="text-2xl font-semibold">Package desk</h1>
      <div key={buildingId} className="mt-4">
        <WaitingList />
      </div>
    </section>
  );
}
