import type { ReactNode } from 'react';

import type { components } from '@/api/schema';
import { relationshipLabel, unitName, useMyOnboarding } from '@/features/onboarding/api';
import { JoinCodeForm } from '@/features/onboarding/JoinCodeForm';

type Membership = components['schemas']['MeMembershipOut'];

/** A message in the shell's main area (the header, with "Log out", stays above it). */
function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-auto max-w-md py-12 text-center">
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      {children}
    </section>
  );
}

const names = (memberships: Membership[]) => memberships.map((m) => m.building.name).join(', ');
const byName = (memberships: Membership[]) => [...memberships].sort((a, b) => a.building.name.localeCompare(b.building.name));

/**
 * Why a user with no active membership can't go further. One screen, in this order: a pending request is
 * the next step to wait for, then a suspension, then a denial; with none of those the user has no building.
 */
export function MembershipStatusScreen({ memberships }: { memberships: Membership[] }) {
  const withStatus = (status: Membership['status']) => memberships.filter((m) => m.status === status);
  const pending = withStatus('pending');
  if (pending.length > 0) return <PendingScreen memberships={pending} />;
  const suspended = withStatus('suspended');
  if (suspended.length > 0) return <SuspendedScreen memberships={suspended} />;
  const denied = withStatus('denied');
  if (denied.length > 0) return <DeniedScreen memberships={denied} />;
  return <NoMembershipScreen />;
}

/** Each pending request with what was submitted, from the caller's own `onboarding/me` (P4-08a). */
export function PendingScreen({ memberships }: { memberships: Membership[] }) {
  return (
    <Notice title="Waiting for approval">
      <ul className="mt-4 flex flex-col gap-3 text-left">
        {byName(memberships).map((m) => (
          <PendingRequest key={m.membership_id} membership={m} />
        ))}
      </ul>
      <p className="mt-4 text-slate-600">You’ll get access as soon as your request is approved.</p>
    </Notice>
  );
}

function PendingRequest({ membership }: { membership: Membership }) {
  // While it loads or if it fails, the building and the wait still show.
  const { data } = useMyOnboarding(membership.building.id);
  return (
    <li data-testid="pending-request" className="rounded border bg-white p-4">
      <h2 className="font-medium">{membership.building.name}</h2>
      {data?.unit_label && (
        <p data-testid="pending-unit">
          Unit {unitName(data.tower, data.unit_label)}
          {data.relationship && ` · ${relationshipLabel(data.relationship)}`}
        </p>
      )}
      <p className="mt-1 text-sm text-slate-600">The building manager will review your request.</p>
    </li>
  );
}

export function SuspendedScreen({ memberships }: { memberships: Membership[] }) {
  return (
    <Notice title="Your access is suspended">
      <p>{names(memberships)}: contact your building’s management to restore it.</p>
    </Notice>
  );
}

/**
 * Each denial with the manager's reason, then a way to ask again. The join request needs the building's code, which
 * no endpoint gives a denied member, so the resident enters it again (P4-08a D2).
 */
export function DeniedScreen({ memberships }: { memberships: Membership[] }) {
  return (
    <Notice title="Your request was not approved">
      <ul className="mt-4 flex flex-col gap-3 text-left">
        {byName(memberships).map((m) => (
          <DeniedRequest key={m.membership_id} membership={m} />
        ))}
      </ul>
      <p className="mt-4">To ask again, enter the join code or link your building gave you.</p>
      <JoinCodeForm submitLabel="Submit again" />
    </Notice>
  );
}

function DeniedRequest({ membership }: { membership: Membership }) {
  const { data } = useMyOnboarding(membership.building.id);
  return (
    <li data-testid="denied-request" className="rounded border bg-white p-4">
      <h2 className="font-medium">{membership.building.name}</h2>
      {data && (
        <p data-testid="denied-reason">{data.decision_reason ? `Reason: ${data.decision_reason}` : 'No reason was given.'}</p>
      )}
      <p className="mt-1 text-sm text-slate-600">Contact the building’s management if you think this is a mistake.</p>
    </li>
  );
}

export function NoMembershipScreen() {
  return (
    <Notice title="You are not a member of a building yet">
      <p>Enter the join code or link your building gave you to request access.</p>
      <JoinCodeForm submitLabel="Continue" />
    </Notice>
  );
}

export function BuildingPicker({ memberships, onPick }: { memberships: Membership[]; onPick: (id: string) => void }) {
  return (
    <Notice title="Choose a building">
      <ul className="mt-4 flex flex-col gap-2">
        {byName(memberships).map((m) => (
          <li key={m.building.id}>
            <button
              type="button"
              className="w-full rounded border bg-white px-4 py-3 text-left hover:bg-slate-100"
              onClick={() => onPick(m.building.id)}
            >
              {m.building.name}
            </button>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** The building answered 404: the membership ended or the building closed after `/me` was loaded. */
export function LostAccessScreen({ onChooseAgain }: { onChooseAgain: () => void }) {
  return (
    <Notice title="You no longer have access to this building">
      <button type="button" className="mt-4 rounded bg-slate-900 px-4 py-2 text-white" onClick={onChooseAgain}>
        Choose again
      </button>
    </Notice>
  );
}
