import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { runAuthCall } from '@/app/authQueue';
import { clearTabChoices, writeSelectedBuilding } from '@/app/buildingStorage';
import { loginPath } from '@/app/safeNext';
import { Field } from '@/features/auth/components/Field';
import { PageHeading } from '@/features/auth/components/PageHeading';
import { PasswordField } from '@/features/auth/components/PasswordField';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  codePoints,
  rateLimitMessage,
  serverFieldErrors,
} from '@/features/auth/formErrors';
import type { SignedInState } from '@/features/auth/pages/LoginPage';

type Role = components['schemas']['Role'];

const ROLE_LABELS: Record<Role, string> = {
  resident: 'Resident',
  security: 'Security',
  property_management: 'Property management',
  council: 'Council',
};

const NAME_REQUIRED = 'Enter your full name.';
const NAME_TOO_LONG = 'Use at most 200 characters.';
const NAME_CONTROL = "The name can't contain line breaks or other control characters.";

// As app/auth/schemas.py::FullName: control characters refused before the strip, 1–200 code points after.
// The password as on the reset page: not trimmed, and the server's common-password check comes back as a 422.
const schema = z
  .object({
    full_name: z
      .string()
      .refine((value) => !/\p{Cc}/u.test(value), NAME_CONTROL)
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, NAME_REQUIRED)
      .refine((value) => codePoints(value) <= 200, NAME_TOO_LONG),
    password: z
      .string()
      .refine((value) => codePoints(value) >= PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT)
      .refine((value) => codePoints(value) <= PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG),
    confirm: z.string(),
  })
  .refine((form) => form.confirm === form.password, { message: "The passwords don't match.", path: ['confirm'] });
type AccountForm = z.input<typeof schema>;
type AccountBody = z.output<typeof schema>;

// The server's 422 types on `full_name`, in this page's words; the password's are formErrors' own.
const SERVER_MESSAGES = {
  full_name: {
    missing: NAME_REQUIRED,
    string_too_short: NAME_REQUIRED,
    string_too_long: NAME_TOO_LONG,
    control_characters: NAME_CONTROL,
  },
};

/** What the accept's refusal leads to; `form` only for the probe's 422 (D1). */
type Stage = 'details' | 'form' | 'login' | 'mismatch' | 'member' | 'unit' | 'invalid';

function stageFor(error: unknown): Stage | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404) return 'invalid';
  if (error.status === 403 && error.code === 'invitation_email_mismatch') return 'mismatch';
  if (error.status !== 409) return null;
  if (error.code === 'login_required') return 'login';
  if (error.code === 'membership_exists') return 'member';
  if (error.code === 'unit_inactive') return 'unit';
  return null;
}

/** The accept's 422 to `{}` when no account has the email: every error is `missing` on the two fields. */
function needsAccount(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.errors?.length) return false;
  return error.errors.every(
    ({ loc, type }) => type === 'missing' && loc.length === 2 && loc[0] === 'body' && ['full_name', 'password'].includes(String(loc[1])),
  );
}

/** The state this page leaves on its entry once it has read `signedIn`: the entry's first key. */
interface EntryState {
  entry?: string;
}

/**
 * One screen per history entry (CLAUDE.md lessons): Back or another invite link keeps a page mounted when only
 * its URL changes, so an accept answering for the entry left behind would act on the new one. Dropping
 * `signedIn` replaces the entry, which gives it a new key: the state keeps the first one, so the screen stays.
 */
export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const location = useLocation();
  return <AcceptInviteScreen key={(location.state as EntryState | null)?.entry ?? location.key} token={token} />;
}

function Screen({ testId, title, children }: { testId: string; title: ReactNode; children?: ReactNode }) {
  return (
    <main data-testid={testId} className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <PageHeading>{title}</PageHeading>
      {children}
    </main>
  );
}

/** Every bad token, and the invite paths without one: one screen, whatever the reason. */
export function InviteInvalid() {
  return (
    <Screen key="invite-invalid" testId="invite-invalid" title="This invitation is no longer valid">
      <p className="text-sm">Ask your building manager to resend it.</p>
    </Screen>
  );
}

/**
 * Accepts an invitation (P4-02b's public routes). The page can't know whether the email has an account or the
 * browser a session, so "Accept invitation" sends the accept with `{}` and the answer picks the next screen
 * (D1). After a login it accepts by itself, from router state the login page sets (D2).
 */
function AcceptInviteScreen({ token }: { token: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // Read once and dropped from the history entry, so a reload or Back to it doesn't accept again.
  const [signedIn] = useState(() => (location.state as SignedInState | null)?.signedIn === true);
  useEffect(() => {
    if ((location.state as SignedInState | null)?.signedIn) {
      const state: EntryState = { entry: location.key };
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state });
    }
  }, [location, navigate]);

  const details = useQuery({
    queryKey: ['invitation', token],
    queryFn: ({ signal }) => api.get('/api/invitations/{token}', { params: { path: { token } }, signal }),
  });
  const [stage, setStage] = useState<Stage>('details');
  const [busy, setBusy] = useState(false);
  // An object, so the same message twice is still a new value and moves focus again.
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);
  // False once the page is gone: an answer that comes later changes nothing on screen.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // One accept or logout at a time: a submit while one is out sends nothing.
  const inFlight = useRef(false);

  const form = useForm<AccountForm, unknown, AccountBody>({
    resolver: zodResolver(schema),
    defaultValues: { full_name: '', password: '', confirm: '' },
  });

  const accept = async (body: { full_name?: string; password?: string }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    let accepted;
    try {
      // Queued like a login: a new account's accept sets the session cookie, which a logout in flight would delete.
      accepted = await runAuthCall(async (signal) => {
        if (!mounted.current) return null;
        return api.post('/api/invitations/{token}/accept', { params: { path: { token } }, body, signal });
      });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const next = stageFor(error) ?? (!('full_name' in body) && needsAccount(error) ? 'form' : null);
      if (next) {
        setStage(next);
        return;
      }
      const placed = serverFieldErrors(error, ['full_name', 'password'] as const, SERVER_MESSAGES);
      if (placed && 'full_name' in body) {
        placed.forEach(({ field, message }, index) => form.setError(field, { message }, { shouldFocus: index === 0 }));
        return;
      }
      setFailure({ message: rateLimitMessage(error) ?? 'Could not accept the invitation. Try again.' });
      return;
    }
    if (accepted === null) return;
    // A new account is now signed in, or this one has a new membership: nothing cached may outlive it, and
    // the tab opens the accepted building even when the user has others.
    queryClient.clear();
    clearTabChoices();
    writeSelectedBuilding(accepted.building_id);
    if (mounted.current) navigate('/', { replace: true });
  };

  // Another account is signed in: log it out here, and stay on the invitation (D4).
  const logout = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await runAuthCall((signal) => api.post('/api/auth/logout', { signal }));
    } catch {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      setFailure({ message: 'Could not log out. Try again.' });
      return;
    }
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'invitation' });
    clearTabChoices();
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setStage('details');
  };

  const autoSent = useRef(false);
  useEffect(() => {
    if (!signedIn || !details.data || autoSent.current) return;
    autoSent.current = true;
    void accept({});
  });

  if (details.isPending) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <p role="status" data-testid="invite-loading">
          Loading the invitation…
        </p>
      </main>
    );
  }
  if (stage === 'invalid' || (details.error instanceof ApiError && details.error.status === 404)) return <InviteInvalid />;
  if (!details.data) {
    return (
      <Screen key="invite-load-error" testId="invite-load-error" title="We couldn't load this invitation">
        <p className="text-sm">{rateLimitMessage(details.error) ?? 'Check your connection and try again.'}</p>
        <button
          type="button"
          onClick={() => void details.refetch()}
          className="mt-4 rounded bg-slate-900 px-4 py-2 font-medium text-white"
        >
          Try again
        </button>
      </Screen>
    );
  }

  const invitation = details.data;
  const alert = failure && (
    <div
      ref={alertRef}
      role="alert"
      tabIndex={-1}
      data-testid="invite-error"
      className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
    >
      {failure.message}
    </div>
  );
  // Before react-hook-form: a duplicate it handled would end its isSubmitting while the first is out (P4-07a F5).
  const guarded = (handler: (event: FormEvent<HTMLFormElement>) => void) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!inFlight.current) handler(event);
  };

  switch (stage) {
    case 'login':
      return (
        <Screen key="invite-login" testId="invite-login" title="Log in to accept">
          <p className="mb-4 text-sm">
            {invitation.email_masked} already has an account. Log in with it to join {invitation.building_name}.
          </p>
          <Link
            to={loginPath({ pathname: `/invite/${encodeURIComponent(token)}`, search: '' })}
            data-testid="invite-login-link"
            className="rounded bg-slate-900 px-4 py-2 text-center font-medium text-white"
          >
            Log in
          </Link>
        </Screen>
      );
    case 'mismatch':
      return (
        <Screen key="invite-mismatch" testId="invite-mismatch" title="You're signed in with another account">
          <p className="mb-4 text-sm">
            This invitation is for {invitation.email_masked}. Log out, then accept it with that email.
          </p>
          {alert}
          <button
            type="button"
            disabled={busy}
            onClick={() => void logout()}
            data-testid="invite-logout"
            className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            Log out
          </button>
        </Screen>
      );
    case 'member':
      return (
        <Screen key="invite-member" testId="invite-member" title={`You're already a member of ${invitation.building_name}`}>
          <Link to="/" className="underline">
            Go to the app
          </Link>
        </Screen>
      );
    case 'unit':
      return (
        <Screen key="invite-unit" testId="invite-unit" title="This invitation can't be accepted">
          <p className="text-sm">
            The unit it was for is no longer active. Ask your building manager to send a new invitation.
          </p>
        </Screen>
      );
    case 'form':
      return (
        <Screen key="invite-account" testId="invite-account" title="Create your account">
          <p className="mb-4 text-sm">
            To join {invitation.building_name} as {invitation.email_masked}.
          </p>
          {alert}
          <form
            noValidate
            data-testid="invite-form"
            onSubmit={guarded((event) => void form.handleSubmit(({ full_name, password }) => accept({ full_name, password }))(event))}
            className="flex flex-col gap-4"
          >
            <Field label="Full name" id="full_name" error={form.formState.errors.full_name?.message}>
              <input
                id="full_name"
                autoComplete="name"
                aria-invalid={form.formState.errors.full_name ? true : undefined}
                aria-describedby={form.formState.errors.full_name ? 'full_name-error' : undefined}
                data-testid="invite-name"
                className="w-full rounded border px-3 py-2"
                {...form.register('full_name')}
              />
            </Field>
            <PasswordField
              id="password"
              label="Password"
              value={form.watch('password')}
              error={form.formState.errors.password?.message}
              testId="invite-password"
              registration={form.register('password')}
            />
            <PasswordField
              id="confirm"
              label="Confirm password"
              value={form.watch('confirm')}
              error={form.formState.errors.confirm?.message}
              testId="invite-confirm"
              registration={form.register('confirm')}
            />
            <button
              type="submit"
              disabled={busy}
              data-testid="invite-submit"
              className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              Create account and accept
            </button>
          </form>
        </Screen>
      );
    default:
      return (
        <Screen key="invite-details" testId="invite-details" title={`Join ${invitation.building_name}`}>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-medium">Building</dt>
            <dd data-testid="invite-building">{invitation.building_name}</dd>
            <dt className="font-medium">Email</dt>
            <dd data-testid="invite-email">{invitation.email_masked}</dd>
            <dt className="font-medium">Roles</dt>
            <dd data-testid="invite-roles">{invitation.roles.map((role) => ROLE_LABELS[role]).join(', ')}</dd>
          </dl>
          {alert}
          {busy && (
            <p role="status" data-testid="invite-accepting" className="mb-4 text-sm">
              Accepting the invitation…
            </p>
          )}
          <form noValidate data-testid="invite-accept-form" onSubmit={guarded(() => void accept({}))}>
            <button
              type="submit"
              disabled={busy}
              data-testid="invite-accept"
              className="w-full rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              Accept invitation
            </button>
          </form>
        </Screen>
      );
  }
}
