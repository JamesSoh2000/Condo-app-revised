import type { ReactNode } from 'react';

import type { components } from '@/api/schema';

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

export function PendingScreen({ memberships }: { memberships: Membership[] }) {
  return (
    <Notice title="Waiting for approval">
      <p>{names(memberships)}: your building’s management hasn’t approved your membership yet.</p>
      <p className="mt-2 text-slate-600">You’ll get access as soon as they do.</p>
    </Notice>
  );
}

export function SuspendedScreen({ memberships }: { memberships: Membership[] }) {
  return (
    <Notice title="Your access is suspended">
      <p>{names(memberships)}: contact your building’s management to restore it.</p>
    </Notice>
  );
}

/** P4-05 adds the manager's reason; until then the screen has none to show. */
export function DeniedScreen({ memberships }: { memberships: Membership[] }) {
  return (
    <Notice title="Your request was not approved">
      <p>{names(memberships)}: contact your building’s management if you think this is a mistake.</p>
    </Notice>
  );
}

/** P4-08 adds the join flow (a code field here); for now the link from the building is the way in. */
export function NoMembershipScreen() {
  return (
    <Notice title="You are not a member of a building yet">
      <p>Open the join link your building gave you to request access.</p>
    </Notice>
  );
}

export function BuildingPicker({ memberships, onPick }: { memberships: Membership[]; onPick: (id: string) => void }) {
  const sorted = [...memberships].sort((a, b) => a.building.name.localeCompare(b.building.name));
  return (
    <Notice title="Choose a building">
      <ul className="mt-4 flex flex-col gap-2">
        {sorted.map((m) => (
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
