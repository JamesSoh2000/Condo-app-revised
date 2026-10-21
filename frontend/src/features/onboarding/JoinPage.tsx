import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { useNewSession } from '@/app/AuthProvider';
import { runAuthCall } from '@/app/authQueue';
import { clearTabChoices } from '@/app/buildingStorage';
import { loginPath } from '@/app/safeNext';
import { Field } from '@/features/auth/components/Field';
import { PageHeading } from '@/features/auth/components/PageHeading';
import { PasswordField } from '@/features/auth/components/PasswordField';
import { NAME_SERVER_MESSAGES, accountSchema } from '@/features/auth/accountSchema';
import { rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import type { SignedInState } from '@/features/auth/pages/LoginPage';
import { relationshipLabel, unitName } from '@/features/onboarding/api';
import { JoinRequestForm, type JoinRequest, type Refusal } from '@/features/onboarding/JoinRequestForm';

const EMAIL_INVALID = 'Enter one email address.';
// app/core/config.py::MAX_EMAIL_ADDRESS_LENGTH; the server counts octets of an ASCII-only address (review round 1, L1).
const EMAIL_TOO_LONG = 'Use at most 254 characters.';
// The server's check is the authority (app/core/config.py::is_email_address); this one catches typos early.
const schema = accountSchema({
  email: z
    .string()
    .trim()
    .refine((value) => /^[^\s@]+@[^\s@]+$/.test(value), EMAIL_INVALID)
    .refine((value) => new TextEncoder().encode(value).length <= 254, EMAIL_TOO_LONG),
});
type SignupForm = z.input<typeof schema>;
type SignupBody = z.output<typeof schema>;
const SERVER_MESSAGES = {
  full_name: NAME_SERVER_MESSAGES,
  email: { missing: EMAIL_INVALID, email_address: EMAIL_INVALID, string_too_long: EMAIL_TOO_LONG },
};

type Stage = 'account' | 'request' | 'sent' | Refusal;

/** False once the component is gone: an answer that comes later changes nothing on screen. */
function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function Screen({ testId, title, children }: { testId: string; title: ReactNode; children?: ReactNode }) {
  return (
    <main data-testid={testId} className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-8">
      <PageHeading>{title}</PageHeading>
      {children}
    </main>
  );
}

/** Every unusable code, and the join paths without one: one screen, whatever the reason. */
export function JoinInvalid() {
  return (
    <Screen key="join-invalid" testId="join-invalid" title="This join link isn't valid">
      <p className="text-sm">Check the link or code with your building’s management.</p>
    </Screen>
  );
}

/**
 * `/join/:code`: one screen per history entry, so an answer for the entry left behind (Back, another join link)
 * can't act on the new one (CLAUDE.md lessons; as `AcceptInvitePage`).
 */
export function JoinPage() {
  const { code = '' } = useParams();
  const location = useLocation();
  return <JoinScreen key={location.key} code={code} />;
}

/**
 * Joining a building from its link (P4-05a's public routes). The page never asks `/me`: a 401 there would send a
 * visitor to the login page instead of the sign-up form. It counts the tab as signed in when the login page or the
 * app sent it here with `signedIn`, or a `/me` is cached (D1).
 */
function JoinScreen({ code }: { code: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const mounted = useMounted();
  const [stage, setStage] = useState<Stage>(() =>
    (location.state as SignedInState | null)?.signedIn || queryClient.getQueryData(['me']) ? 'request' : 'account',
  );
  const [sent, setSent] = useState<JoinRequest | null>(null);
  const lookup = useQuery({
    queryKey: ['join', code],
    queryFn: ({ signal }) => api.get('/api/join/{join_code}', { params: { path: { join_code: code } }, signal }),
  });

  if (lookup.isPending) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <p role="status">Loading…</p>
      </main>
    );
  }
  if (stage === 'invalid' || (lookup.error instanceof ApiError && lookup.error.status === 404)) return <JoinInvalid />;
  if (!lookup.data) {
    return (
      <Screen key="join-load-error" testId="join-load-error" title="We couldn't open this join link">
        <p className="text-sm">{rateLimitMessage(lookup.error) ?? 'Check your connection and try again.'}</p>
        <button type="button" onClick={() => void lookup.refetch()} className="mt-4 rounded bg-slate-900 px-4 py-2 font-medium text-white">
          Try again
        </button>
      </Screen>
    );
  }

  const name = lookup.data.building_name;
  const toApp = (
    <Link to="/" className="mt-4 underline">
      Go to the app
    </Link>
  );
  const onSent = (request: JoinRequest, active: boolean | null) => {
    // Without an active membership the guard's pending screen is the confirmation (D3).
    if (active !== true) return navigate('/', { replace: true });
    setSent(request);
    setStage('sent');
  };

  switch (stage) {
    case 'member':
      return (
        <Screen key="join-member" testId="join-member" title={`You're already a member of ${name}`}>
          {toApp}
        </Screen>
      );
    case 'not-eligible':
      return (
        <Screen key="join-not-eligible" testId="join-not-eligible" title={`You can't join ${name} right now`}>
          <p className="text-sm">Your membership here is suspended or has ended; contact the building’s management.</p>
        </Screen>
      );
    case 'sent':
      return (
        <Screen key="join-sent" testId="join-sent" title="Request sent">
          {sent && (
            <p>
              {name}: unit {unitName(sent.tower, sent.unit_label)} · {relationshipLabel(sent.relationship)}
            </p>
          )}
          <p className="mt-2 text-slate-600">The building manager will review your request.</p>
          {toApp}
        </Screen>
      );
    case 'request':
      return (
        <Screen key="join-request" testId="join-request" title={`Join ${name}`}>
          <p className="mb-4 text-sm">Tell the building which unit is yours. The building manager reviews every request.</p>
          <JoinRequestForm code={code} mounted={mounted} onSent={onSent} onRefused={setStage} />
        </Screen>
      );
    default:
      return (
        <Screen key="join-account" testId="join-account" title={`Join ${name}`}>
          <p className="mb-4 text-sm">Create your account to ask to join.</p>
          <SignupForm code={code} mounted={mounted} onSignedUp={() => setStage('request')} />
        </Screen>
      );
  }
}

function SignupForm({ code, mounted, onSignedUp }: { code: string; mounted: { readonly current: boolean }; onSignedUp: () => void }) {
  const queryClient = useQueryClient();
  const newSession = useNewSession();
  const login = loginPath({ pathname: `/join/${encodeURIComponent(code)}`, search: '' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; login?: true } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);
  const inFlight = useRef(false);
  const form = useForm<SignupForm, unknown, SignupBody>({
    resolver: zodResolver(schema),
    defaultValues: { full_name: '', email: '', password: '', confirm: '' },
  });

  const signUp = async ({ full_name, email, password }: SignupBody) => {
    setBusy(true);
    setFailure(null);
    let created: boolean;
    try {
      // Queued like a login: the sign-up sets the session cookie, which a logout in flight would delete.
      created = await runAuthCall(async (signal) => {
        if (!mounted.current) return false;
        await api.post('/api/auth/signup', { body: { full_name, email, password }, signal });
        return true;
      });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      if (error instanceof ApiError && error.status === 409 && error.code === 'email_in_use') {
        return setFailure({ message: 'An account already uses this email.', login: true });
      }
      const placed = serverFieldErrors(error, ['full_name', 'email', 'password'] as const, SERVER_MESSAGES);
      if (placed) {
        placed.forEach(({ field, message }, index) => form.setError(field, { message }, { shouldFocus: index === 0 }));
        return;
      }
      return setFailure({ message: rateLimitMessage(error) ?? 'Could not create your account. Try again.' });
    }
    if (!created) return;
    // A new user is signed in: nothing cached of a previous one may outlive it, and a shell the user went back to
    // meanwhile is rebuilt for the new one (P4-07b R3-1). The join links' public lookups stay.
    queryClient.removeQueries({ predicate: ({ queryKey }) => !(queryKey[0] === 'join' && queryKey.length === 2) });
    newSession();
    clearTabChoices();
    if (mounted.current) onSignedUp();
  };

  // Before react-hook-form: a duplicate it handled would end its isSubmitting while the first is out (P4-07a F5).
  // Taken before validation, which is asynchronous: two submits in one tick would both pass it (review round 1, M2).
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    void form.handleSubmit(signUp, () => {
      inFlight.current = false;
    })(event);
  };
  const { errors } = form.formState;
  const described = (field: keyof SignupForm) => ({
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? `${field}-error` : undefined,
  });

  return (
    <>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} data-testid="join-error" className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {failure.message}{' '}
          {failure.login && (
            <Link to={login} className="underline">
              Log in instead
            </Link>
          )}
        </div>
      )}
      <form noValidate data-testid="join-signup-form" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Full name" id="full_name" error={errors.full_name?.message}>
          <input id="full_name" autoComplete="name" className="w-full rounded border px-3 py-2" {...described('full_name')} {...form.register('full_name')} />
        </Field>
        <Field label="Email" id="email" error={errors.email?.message}>
          <input id="email" type="email" autoComplete="email" className="w-full rounded border px-3 py-2" {...described('email')} {...form.register('email')} />
        </Field>
        <PasswordField id="password" label="Password" value={form.watch('password')} error={errors.password?.message} testId="join-password" registration={form.register('password')} />
        <PasswordField id="confirm" label="Confirm password" value={form.watch('confirm')} error={errors.confirm?.message} testId="join-confirm" registration={form.register('confirm')} />
        <button type="submit" disabled={busy} className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">
          Create account
        </button>
      </form>
      <p className="mt-4 text-sm">
        Already have an account?{' '}
        <Link to={login} data-testid="join-login-link" className="underline">
          Log in
        </Link>
      </p>
    </>
  );
}
