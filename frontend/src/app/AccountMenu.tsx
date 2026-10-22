import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { useMe } from '@/app/AuthProvider';
import { useBuilding, useBuildingContext } from '@/app/BuildingProvider';
import type { ViewAs } from '@/app/buildingStorage';
import { useCanViewAs } from '@/app/MainNav';

/**
 * The header's account menu (P2-06c): a disclosure, so a button that shows a panel (WAI-ARIA disclosure
 * pattern), not an ARIA `menu`, which can't hold the `<select>` and radio buttons it contains. Escape and a
 * click or tap outside close it; Escape returns focus to the button. It is open only at the location and building
 * it was opened at, so following a link or a `/me`-driven building change closes it (review round 2, Claude L4), and
 * it is forgotten then, so Back to that location doesn't show it again (P4-08f criteria 1, 2).
 */
export function AccountMenu({ onLogout, loggingOut }: { onLogout: () => void; loggingOut: boolean }) {
  const { data: me } = useMe();
  const { buildingId } = useBuildingContext();
  const { key } = useLocation();
  const at = `${key} ${buildingId ?? ''}`;
  const [openAt, setOpenAt] = useState<string | null>(null);
  if (openAt !== null && openAt !== at) setOpenAt(null);
  const open = openAt === at;
  const setOpen = (value: boolean) => setOpenAt(value ? at : null);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `mousedown`: iOS Safari may send no mouse event for a tap on empty space (P4-08f criterion 4).
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenAt(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    setOpen(false);
    button.current?.focus();
  };

  return (
    // Not positioned below 640 px, so the panel is placed against the header: it spans it, inside the viewport,
    // whatever the buttons' widths. From 640 px up it hangs under the button (P4-08h).
    <div ref={root} className="sm:relative" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="rounded border px-3 py-1 text-sm"
      >
        <span className="sr-only">Account menu: </span>
        <span>{me?.user.full_name}</span>
        <span aria-hidden> ▾</span>
      </button>
      {open && (
        <div id={panelId} className="absolute left-4 right-4 z-10 mt-2 flex flex-col gap-3 rounded border bg-white p-3 shadow sm:left-auto sm:right-0 sm:w-64">
          <p className="text-sm text-slate-600 [overflow-wrap:anywhere]">Signed in as {me?.user.email}</p>
          {buildingId !== null && (
            <BuildingChoices
              onSwitch={() => {
                // The focused <select> goes with the panel: keep keyboard users' place (review round 1, F3).
                setOpen(false);
                button.current?.focus();
              }}
            />
          )}
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            onClick={onLogout}
            disabled={loggingOut}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

/** The tab's building (its name, or a switcher with several active memberships) and council "view as". */
function BuildingChoices({ onSwitch }: { onSwitch: () => void }) {
  const { buildingId, active, select, viewAs, setViewAs } = useBuildingContext();
  // Reads what the guards loaded: opening the menu must not ask for the building (review rounds 1 and 2).
  const { data: building } = useBuilding({ passive: true });
  const canViewAs = useCanViewAs(building);
  const name = useId();

  return (
    <>
      {active.length === 1 ? (
        <p className="text-sm font-medium">{active[0].building.name}</p>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span>Building</span>
          <select
            className="rounded border px-2 py-1"
            value={buildingId ?? ''}
            onChange={(event) => {
              select(event.target.value);
              onSwitch();
            }}
          >
            {active.map((m) => (
              <option key={m.building.id} value={m.building.id}>
                {m.building.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {canViewAs && (
        <fieldset className="text-sm">
          <legend className="mb-1">View as</legend>
          {(['management', 'resident'] as const satisfies readonly ViewAs[]).map((view) => (
            <label key={view} className="mr-4 inline-flex items-center gap-1">
              <input
                type="radio"
                name={name}
                value={view}
                checked={viewAs === view}
                onChange={() => setViewAs(view)}
              />
              {view === 'management' ? 'Management' : 'Resident'}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
