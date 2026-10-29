import { useEffect, useRef, useState } from 'react';

import { useBuilding, useBuildingContext, useBuildingDenied, useBuildingId } from '@/app/BuildingProvider';
import { CancelDialog } from '@/features/maintenance/CancelDialog';
import { EmergencyNotice } from '@/features/maintenance/EmergencyNotice';
import { MyMaintenanceList } from '@/features/maintenance/MyMaintenanceList';
import { SubmitRequestForm } from '@/features/maintenance/SubmitRequestForm';
import type { MaintenanceRequest } from '@/features/maintenance/api';
import { buildingTime } from '@/features/packages/time';

/**
 * `/maintenance` (P6-04a), for residents: their maintenance requests, the "New request" panel and each request's
 * cancel (P6-04b). The route also takes `/maintenance/<id>`, the notifications' link, so P6-04c's view of one request
 * mounts on this page; until then it shows the list. Keyed by building, so nothing of one building's list, form or
 * dialog shows in another, and nothing typed in one is sent to the other (P6-04b criterion 8).
 */
export function MyMaintenancePage() {
  const buildingId = useBuildingId();
  return <Maintenance key={buildingId} buildingId={buildingId} />;
}

function Maintenance({ buildingId }: { buildingId: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Under the page's guards, which render it only once the building has loaded; a denied building shows nothing of it.
  const building = useBuilding({ passive: true }).data;
  const time = useBuildingDenied() ? undefined : buildingTime(building);
  const membership = useBuildingContext().active.find((one) => one.building.id === buildingId);
  const [formOpen, setFormOpen] = useState(false);
  const [submitted, setSubmitted] = useState<MaintenanceRequest | null>(null);
  const [cancelling, setCancelling] = useState<{ item: MaintenanceRequest; opener: HTMLButtonElement } | null>(null);
  const [cancelled, setCancelled] = useState(false);

  // Set by Close: "New request" comes back once the panel is gone, and takes focus then.
  const focusNew = useRef(false);

  useEffect(() => {
    if (submitted) outcomeRef.current?.focus();
  }, [submitted]);
  useEffect(() => {
    if (formOpen || !focusNew.current) return;
    focusNew.current = false;
    newRef.current?.focus();
  }, [formOpen]);

  const card = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-request-id="${id}"]`);

  function openForm() {
    setSubmitted(null);
    setCancelled(false);
    setFormOpen(true);
  }

  function closeForm() {
    focusNew.current = true;
    setFormOpen(false);
  }

  function closeDialog(done: boolean) {
    if (!cancelling) return;
    const { item, opener } = cancelling;
    setCancelling(null);
    setCancelled(done);
    // After a cancel the button is gone; after a refusal the refresh may have removed it too.
    (done || !opener.isConnected ? card(item.id) : opener)?.focus();
  }

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold">
        Maintenance requests
      </h1>
      {formOpen ? (
        <SubmitRequestForm
          buildingId={buildingId}
          occupancy={membership?.occupancy ?? null}
          onClose={closeForm}
          onSubmitted={(made) => {
            setFormOpen(false);
            setSubmitted(made);
          }}
        />
      ) : (
        <button ref={newRef} type="button" onClick={openForm} className="min-h-11 self-start rounded bg-blue-700 px-4 text-white">
          New request
        </button>
      )}
      {submitted && (
        <div ref={outcomeRef} tabIndex={-1} role="status" data-testid="maintenance-outcome" className="flex min-w-0 flex-col gap-2 rounded border bg-white p-3">
          {submitted.category === 'emergency' ? <EmergencyNotice submitted phone={submitted.emergency_phone} /> : <p>Your request was submitted.</p>}
          <button
            type="button"
            onClick={() => {
              setSubmitted(null);
              newRef.current?.focus();
            }}
            className="min-h-11 self-start rounded border px-4 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}
      <p role="status" className="text-sm text-green-800">
        {cancelled ? 'Request cancelled.' : ''}
      </p>
      <div ref={listRef}>
        <MyMaintenanceList
          buildingId={buildingId}
          time={time}
          focusHeading={() => headingRef.current?.focus()}
          membershipId={membership?.membership_id ?? null}
          onCancel={(item, opener) => setCancelling({ item, opener })}
        />
      </div>
      {cancelling && <CancelDialog buildingId={buildingId} item={cancelling.item} onClose={closeDialog} />}
    </section>
  );
}
