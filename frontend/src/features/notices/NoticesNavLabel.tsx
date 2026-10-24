import { useBuildingId } from '@/app/BuildingProvider';
import { useNoticeSummary } from '@/features/notices/api';

/**
 * The nav's "Notices" item with the unread count (P6-02a), as `PackagesNavLabel`: "Notices, 2 unread" to a screen
 * reader, a "2" badge on screen, nothing extra with none. Rendered only while the nav lists the item, so only a member
 * of a building with notices on asks for the count.
 */
export function NoticesNavLabel({ label }: { label: string }) {
  const summary = useNoticeSummary(useBuildingId());
  // A failed refresh shows no count rather than the last one, as the bell.
  const count = summary.isError ? undefined : summary.data?.unread;
  if (!count) return <>{label}</>;
  return (
    <>
      <span aria-hidden>{label}</span>
      <span aria-hidden className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">{`${label}, ${count} unread`}</span>
    </>
  );
}
