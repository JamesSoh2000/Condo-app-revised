import { useRef, type KeyboardEvent } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import { useBuildingId } from '@/app/BuildingProvider';
import { PendingRequests } from '@/features/residents/PendingRequests';

const TABS = [
  { id: 'pending', label: 'Pending requests' },
  { id: 'members', label: 'Members' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/**
 * `/manage/residents` (P4-08b), for property management: the join requests to decide, and the members (P4-08c).
 * The tab is in the URL (`?tab=members`), so Back and Forward switch it. The panel is keyed by history entry and
 * building, so nothing of one entry's panel (an open dialog, a message) shows on another; the tablist is not,
 * so a tab keeps focus when the URL changes.
 */
export function ResidentsPage() {
  const [params, setParams] = useSearchParams();
  const { key } = useLocation();
  const buildingId = useBuildingId();
  const tab: Tab = params.get('tab') === 'members' ? 'members' : 'pending';
  const tabs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const select = (next: Tab) => {
    if (next !== tab) setParams(next === 'pending' ? {} : { tab: next });
  };
  // The tablist pattern: arrows move between tabs and select, Home and End go to the ends.
  const onKeyDown = (event: KeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = TABS[(moves[event.key] + TABS.length) % TABS.length].id;
    select(next);
    tabs.current[next]?.focus();
  };

  return (
    <section>
      <h1 className="text-2xl font-semibold">Residents</h1>
      <div role="tablist" aria-label="Residents" className="mt-4 flex gap-2 border-b" onKeyDown={onKeyDown}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            ref={(element) => {
              tabs.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`residents-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="residents-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => select(id)}
            className={`-mb-px min-h-11 border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div key={`${buildingId}:${key}`} role="tabpanel" id="residents-panel" aria-labelledby={`residents-tab-${tab}`} className="mt-4">
        {tab === 'pending' ? (
          <PendingRequests />
        ) : (
          <p className="text-slate-600">Member administration is coming in a later update.</p>
        )}
      </div>
    </section>
  );
}
