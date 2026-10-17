import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { runAuthCall } from '@/app/authQueue';
import { clearSelectedBuilding } from '@/app/buildingStorage';
import { safeNext } from '@/app/safeNext';

// The backend takes any non-empty email string (a malformed one is just unknown: 401, not 422), so the
// form checks no email format either. Lengths match app/auth/schemas.py::LoginIn, which counts code points;
// JavaScript's length counts UTF-16 units (an emoji is 2), hence codePoints().
const codePoints = (value: string) => [...value].length;
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
    const wait =
      seconds < 120 ? `${seconds} second${seconds === 1 ? '' : 's'}` : `${Math.ceil(seconds / 60)} minutes`;
    return `Too many sign-in attempts. Try again in ${wait}.`;
  }
  return 'Could not sign in. Try again.';
}

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
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

  const onSubmit = async (body: LoginForm) => {
    setFailure(null);
    let sent: boolean;
    try {
      // Queued behind any logout still in flight, whose response would delete this login's cookie.
      sent = await runAuthCall(async () => {
        if (!mounted.current) return false;
        await api.post('/api/auth/login', { body });
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
    clearSelectedBuilding();
    if (mounted.current) navigate(safeNext(params.get('next')), { replace: true });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
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
    </main>
  );
}

function Field({ label, id, error, children }: { label: string; id: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
