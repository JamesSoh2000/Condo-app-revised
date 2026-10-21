import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { runAuthCall } from '@/app/authQueue';
import { clearTabChoices } from '@/app/buildingStorage';
import { safeNext } from '@/app/safeNext';
import { Field } from '@/features/auth/components/Field';
import { codePoints, waitText } from '@/features/auth/formErrors';
import type { LoginState } from '@/features/auth/pages/ResetPasswordPage';

// The backend takes any non-empty email string (a malformed one is just unknown: 401, not 422), so the
// form checks no email format either. Lengths match app/auth/schemas.py::LoginIn, which counts code points.
const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email.')
    .refine((value) => codePoints(value) <= 320, 'This email is too long.'),
  password: z
    .string()
    .min(1, 'Enter your password.')
    .refine((value) => codePoints(value) <= 128, 'This password is too long.'),
});
type LoginForm = z.infer<typeof schema>;

/** The message for a failed login. Branches on status and code, never on the server's text. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Email or password is incorrect.';
  if (error instanceof ApiError && error.status === 429) {
    const seconds = error.retryAfter;
    if (!seconds) return 'Too many sign-in attempts. Try again later.';
    return `Too many sign-in attempts. Try again in ${waitText(seconds)}.`;
  }
  return 'Could not sign in. Try again.';
}

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  // After a reset (router state, never the URL: D2). Kept here and dropped from the history entry, so a
  // reload or a return to this entry doesn't announce it again.
  const [passwordUpdated] = useState(() => (location.state as LoginState | null)?.passwordUpdated === true);
  useEffect(() => {
    if ((location.state as LoginState | null)?.passwordUpdated)
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [location, navigate]);
  // An object, so the same message twice is still a new value and moves focus again.
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  // False once this form is gone (Back, another page): a login still queued for it must not run.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (failure) summaryRef.current?.focus();
  }, [failure]);

  // Already signed in (a bookmark, Back, another tab's login): go where the login would have gone. Queued
  // like a login, so a logout still in flight answers first, and skipped if the form is gone by then. A
  // 401 is AuthProvider's (it clears the tab; on this page it navigates nowhere); other errors show the form.
  // `next` is read when /me (or a login) answers: Back or Forward between two /login URLs keeps this page
  // mounted and changes only the search (review round 2).
  const next = useRef<string | null>(null);
  next.current = params.get('next');
  useEffect(() => {
    runAuthCall(async (signal) => {
      if (!mounted.current) return;
      const me = await api.get('/api/auth/me', { signal });
      if (!mounted.current) return;
      queryClient.setQueryData(['me'], me);
      navigate(safeNext(next.current), { replace: true });
    }).catch(() => undefined);
  }, [navigate, queryClient]);

  const onSubmit = async (body: LoginForm) => {
    setFailure(null);
    let sent: boolean;
    try {
      // Queued behind any logout still in flight, whose response would delete this login's cookie.
      sent = await runAuthCall(async (signal) => {
        if (!mounted.current) return false;
        await api.post('/api/auth/login', { body, signal });
        return true;
      });
    } catch (error) {
      if (!mounted.current) return;
      resetField('password');
      setFailure({ message: loginErrorMessage(error) });
      return;
    }
    if (!sent) return;
    // Nothing cached before this login (another user's data, a lost session's) may show after it, and the
    // tab's building is chosen again from this user's memberships.
    queryClient.clear();
    clearTabChoices();
    if (mounted.current) navigate(safeNext(next.current), { replace: true });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
      {passwordUpdated && (
        <div
          role="status"
          data-testid="login-banner"
          className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800"
        >
          Your password was updated. Sign in with your new password.
        </div>
      )}
      {failure && (
        <div
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
          className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {failure.message}
        </div>
      )}
      <form noValidate onSubmit={(event) => void handleSubmit(onSubmit)(event)} className="flex flex-col gap-4">
        <Field label="Email" id="email" error={errors.email?.message}>
          <input
            id="email"
            type="email"
            autoComplete="username"
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            className="w-full rounded border px-3 py-2"
            {...register('email')}
          />
        </Field>
        <Field label="Password" id="password" error={errors.password?.message}>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            className="w-full rounded border px-3 py-2"
            {...register('password')}
          />
        </Field>
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          Sign in
        </button>
      </form>
      <Link to="/forgot-password" data-testid="login-forgot-link" className="mt-4 text-sm underline">
        Forgot password?
      </Link>
    </main>
  );
}
