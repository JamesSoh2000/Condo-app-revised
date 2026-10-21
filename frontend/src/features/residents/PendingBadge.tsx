import { useBuildingId } from '@/app/BuildingProvider';
import { usePendingSummary } from '@/features/residents/api';

/**
 * The nav's "Residents" item with the pending count (P4-08d): "Residents, 3 pending" to a screen reader, a "3" badge
 * on screen, nothing extra with none. Rendered only while the nav lists the item, so only a property manager, and not
 * while a council member views as a resident, asks for the count.
 */
export function ResidentsNavLabel({ label }: { label: string }) {
  const summary = usePendingSummary(useBuildingId());
  // A failed refresh shows no count rather than the last one, as the bell.
  const count = summary.isError ? undefined : summary.data?.pending_onboarding_count;
  if (!count) return <>{label}</>;
  // The whole name in one hidden span: Chromium puts a space before an absolutely positioned `sr-only` part, so
  // "Residents" + ", 3 pending" read as "Residents , 3 pending" there (the stack run; jsdom joins them).
  return (
    <>
      <span aria-hidden>{label}</span>
      <span aria-hidden className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">{`${label}, ${count} pending`}</span>
    </>
  );
}
