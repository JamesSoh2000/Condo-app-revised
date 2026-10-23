import { useBuildingId } from '@/app/BuildingProvider';
import { usePackageSummary } from '@/features/packages/api';

/**
 * The nav's "My packages" item with the waiting count (P5-04), as the residents' `ResidentsNavLabel`: "My packages,
 * 2 waiting" to a screen reader, a "2" badge on screen, nothing extra with none. Rendered only while the nav lists
 * the item, so only a resident in a building with packages on asks for the count.
 */
export function PackagesNavLabel({ label }: { label: string }) {
  const summary = usePackageSummary(useBuildingId());
  // A failed refresh shows no count rather than the last one, as the bell.
  const count = summary.isError ? undefined : summary.data?.waiting;
  if (!count) return <>{label}</>;
  return (
    <>
      <span aria-hidden>{label}</span>
      <span aria-hidden className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">{`${label}, ${count} waiting`}</span>
    </>
  );
}
