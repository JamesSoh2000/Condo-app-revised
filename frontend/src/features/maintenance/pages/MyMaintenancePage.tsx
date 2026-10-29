import { useEffect, useRef, useState } from 'react';

import { useBuilding, useBuildingContext, useBuildingDenied, useBuildingId } from '@/app/BuildingProvider';
import { EmergencyNotice } from '@/features/maintenance/EmergencyNotice';
import { MyMaintenanceList } from '@/features/maintenance/MyMaintenanceList';
import { SubmitRequestForm } from '@/features/maintenance/SubmitRequestForm';
import type { MaintenanceRequest } from '@/features/maintenance/api';
import { buildingTime } from '@/features/packages/time';

/**
 * `/maintenance` (P6-04a), for residents: their maintenance requests and the "New request" panel (P6-04b). The route
 * also takes `/maintenance/<id>`, the notifications' link, so P6-04c's view of one request mounts on this page; until
 * then it shows the list. Keyed by building, so nothing of one building's list or form shows in another, and nothing
 * typed in one is sent to the other (P6-04b criterion 8).
 */
export function MyMaintenancePage() {
  const buildingId = useBuildingId();
  return <Maintenance key={buildingId} buildingId={buildingId} />;
}

function Maintenance({ buildingId }: { buildingId: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const emergencyRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // Under the page's guards, which render it only once the building has loaded; a denied building shows nothing of it.
  const building = useBuilding({ passive: true }).data;
  const time = useBuildingDenied() ? undefined : buildingTime(building);
  const membership = useBuildingContext().active.find((one) => one.building.id === buildingId);
  const [formOpen, setFormOpen] = useState(false);
  // The last ordinary request's outcome, gone with the next form; an emergency request's text and phone stay until
  // their own Dismiss, whatever is opened or sent after (criterion 6; review round 1 F2).
  const [submitted, setSubmitted] = useState<MaintenanceRequest | null>(null);
  const [emergency, setEmergency] = useState<MaintenanceRequest | null>(null);

  // Set by Close: "New request" comes back once the panel is gone, and takes focus then.
  const focusNew = useRef(false);

  useEffect(() => {
    if (submitted) outcomeRef.current?.focus();
  }, [submitted]);
  useEffect(() => {
    if (emergency) emergencyRef.current?.focus();
  }, [emergency]);
  useEffect(() => {
    if (formOpen || !focusNew.current) return;
    focusNew.current = false;
    newRef.current?.focus();
  }, [formOpen]);

  function openForm() {
    setSubmitted(null);
    setFormOpen(true);
  }

  function closeForm() {
    focusNew.current = true;
    setFormOpen(false);
  }

  function dismissEmergency() {
    setEmergency(null);
    // "New request", or with the form open (it replaces the button) the form's first enabled field, or while the form is
    // sending (its fields disabled) its status line; each stays (review round 2 F1). The heading if none is there.
    const target =
      newRef.current ??
      sectionRef.current?.querySelector<HTMLElement>('form :is(input, select, textarea):not(:disabled), form [role="status"]') ??
      headingRef.current;
    target?.focus();
  }

  return (
    <section ref={sectionRef} className="flex min-w-0 flex-col gap-4">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold">
        Maintenance requests
      </h1>
      {emergency && (
        <div ref={emergencyRef} tabIndex={-1} role="status" data-testid="emergency-outcome" className="flex min-w-0 flex-col gap-2">
          <EmergencyNotice submitted phone={emergency.emergency_phone} />
          <button type="button" onClick={dismissEmergency} className="min-h-11 self-start rounded border px-4 text-sm">
            Dismiss
          </button>
        </div>
      )}
      {formOpen ? (
        <SubmitRequestForm
          buildingId={buildingId}
          occupancy={membership?.occupancy ?? null}
          onClose={closeForm}
          onSubmitted={(made) => {
            setFormOpen(false);
            if (made.category === 'emergency') setEmergency(made);
            else setSubmitted(made);
          }}
        />
      ) : (
        <button ref={newRef} type="button" onClick={openForm} className="min-h-11 self-start rounded bg-blue-700 px-4 text-white">
          New request
        </button>
      )}
      {submitted && (
        <div ref={outcomeRef} tabIndex={-1} role="status" data-testid="maintenance-outcome" className="flex min-w-0 flex-col gap-2 rounded border bg-white p-3">
          <p>Your request was submitted.</p>
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
      <MyMaintenanceList buildingId={buildingId} time={time} focusHeading={() => headingRef.current?.focus()} />
    </section>
  );
}
