import { useBuildingId } from '@/app/BuildingProvider';
import { LogPackageForm } from '@/features/packages/LogPackageForm';
import { WaitingList } from '@/features/packages/WaitingList';

/**
 * `/security/packages` (P5-03b), for security and property management: the "Log package" panel (P5-03c) above the
 * packages waiting at the desk. Keyed by building, so nothing of one building's form, filters or list shows in
 * another. P5-03d adds pickup and return.
 */
export function SecurityPackagesPage() {
  const buildingId = useBuildingId();
  return (
    <section>
      <h1 className="text-2xl font-semibold">Package desk</h1>
      <div key={buildingId} className="mt-4 flex flex-col gap-8">
        <section aria-labelledby="log-package-heading" className="rounded border bg-slate-50 p-4">
          <h2 id="log-package-heading" className="mb-3 text-lg font-semibold">
            Log package
          </h2>
          <LogPackageForm headingId="log-package-heading" />
        </section>
        <WaitingList />
      </div>
    </section>
  );
}
