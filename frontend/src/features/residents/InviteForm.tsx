import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import { ROLE_LABELS, useInvite, type MemberRole, type Relationship } from '@/features/residents/api';
import { RelationshipField, UNIT_GONE, UnitPicker, unitGone, useUnitPicker } from '@/features/residents/UnitPicker';

/** In `Role`'s order, Resident first; a resident is invited with a unit (P4-08i). */
const ROLES = Object.keys(ROLE_LABELS) as MemberRole[];
// The join form's checks and words (P4-08a). The server's check is the authority
// (app/core/config.py::is_email_address), counting octets of an ASCII-only address; this one catches typos early.
const EMAIL_INVALID = 'Enter one email address.';
const EMAIL_TOO_LONG = 'Use at most 254 characters.';
const SERVER_MESSAGES = { email: { missing: EMAIL_INVALID, email_address: EMAIL_INVALID, string_too_long: EMAIL_TOO_LONG } };

function emailProblem(email: string): string | null {
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return EMAIL_INVALID;
  return new TextEncoder().encode(email).length > 254 ? EMAIL_TOO_LONG : null;
}

/** What a refusal the form can't place on a field says. */
function refusal(error: unknown, email: string): string {
  if (error instanceof ApiError && error.status === 409 && error.code === 'invitation_pending') {
    return `${email} already has a pending invitation.`;
  }
  if (error instanceof ApiError && error.status === 403 && error.code === 'forbidden_role') {
    return 'You can no longer invite people to this building.';
  }
  return rateLimitMessage(error) ?? 'Could not send the invitation. Try again.';
}

interface Props {
  buildingId: string;
  /** A Send that passed the checks is going out. */
  onStart: () => void;
  /** With the email the server wrote. Not called once the form is gone. */
  onSent: (email: string) => void;
}

/**
 * Invite people by email (P4-08g, P4-08i): the email and at least one role; with Resident, a unit and how they relate
 * to it, both required (P4-08i D2). The checks show from the first Send and follow what is typed after it. One
 * request per Send, as the residents dialogs; a refusal keeps what was typed.
 */
export function InviteForm({ buildingId, onStart, onSent }: Props) {
  const invite = useInvite(buildingId);
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const firstRole = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<ReadonlySet<MemberRole>>(new Set());
  const resident = roles.has('resident');
  const picker = useUnitPicker(buildingId, resident);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const unitSearch = useRef<HTMLInputElement>(null);
  const firstRelationship = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState(false);
  // The server's word on the email, until it is edited.
  const [serverEmail, setServerEmail] = useState<string | null>(null);
  // Its own object each time, so the same message again still moves focus to it.
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  const emailError = serverEmail ?? (checked ? emailProblem(email.trim()) : null);
  const rolesError = checked && roles.size === 0 ? 'Choose at least one role.' : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    setChecked(true);
    setFailure(null);
    const address = email.trim();
    // The server's word too: the same address would be refused again (review round 2, Codex F1).
    if (emailProblem(address) || serverEmail) return emailRef.current?.focus();
    if (roles.size === 0) return firstRole.current?.focus();
    if (resident && picker.chosen === null) return unitSearch.current?.focus();
    if (resident && relationship === null) return firstRelationship.current?.focus();
    inFlight.current = true;
    setBusy(true);
    onStart();
    // The button about to be disabled would drop focus to <body> in a browser.
    form.current?.focus();
    let sent;
    try {
      const unit = resident && picker.chosen && relationship ? { unit_id: picker.chosen, relationship } : {};
      sent = await invite.mutateAsync({ email: address, roles: ROLES.filter((role) => roles.has(role)), ...unit });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const placed = serverFieldErrors(error, ['email'], SERVER_MESSAGES);
      if (placed) {
        setServerEmail(placed[0].message);
        return emailRef.current?.focus();
      }
      if (unitGone(error)) {
        picker.unitGone();
        return setFailure({ message: UNIT_GONE });
      }
      return setFailure({ message: refusal(error, address) });
    }
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setEmail('');
    setRoles(new Set());
    picker.clear();
    setRelationship(null);
    setChecked(false);
    onSent(sent.email);
  };

  const toggle = (role: MemberRole) =>
    setRoles((current) => {
      const next = new Set(current);
      if (!next.delete(role)) next.add(role);
      return next;
    });

  return (
    <form ref={form} tabIndex={-1} noValidate onSubmit={(event) => void submit(event)} aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Invite people
      </h2>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure.message}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-email`} className="text-sm font-medium">
          Email
        </label>
        <input
          ref={emailRef}
          id={`${id}-email`}
          type="email"
          autoComplete="off"
          value={email}
          readOnly={busy}
          onChange={(event) => {
            setEmail(event.target.value);
            setServerEmail(null);
          }}
          aria-invalid={emailError !== null}
          aria-describedby={emailError ? `${id}-email-error` : undefined}
          className="w-full min-w-0 rounded border px-3 py-2"
        />
        {emailError && (
          <p id={`${id}-email-error`} className="text-sm text-red-700">
            {emailError}
          </p>
        )}
      </div>
      <fieldset aria-describedby={rolesError ? `${id}-roles-error` : undefined}>
        <legend className="mb-1 text-sm font-medium">Roles</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {ROLES.map((role, index) => (
            <label key={role} className="flex min-h-11 items-center gap-2 rounded border px-3 py-2">
              <input ref={index === 0 ? firstRole : undefined} type="checkbox" checked={roles.has(role)} disabled={busy} onChange={() => toggle(role)} />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
        {rolesError && (
          <p id={`${id}-roles-error`} className="mt-1 text-sm text-red-700">
            {rolesError}
          </p>
        )}
      </fieldset>
      {resident && (
        <>
          <UnitPicker picker={picker} legend="Unit" busy={busy} missing={checked} searchRef={unitSearch} />
          <RelationshipField value={relationship} onChange={setRelationship} busy={busy} missing={checked} firstRef={firstRelationship} />
        </>
      )}
      <button type="submit" disabled={busy} className="min-h-11 self-start rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">
        Send invitation
      </button>
    </form>
  );
}
