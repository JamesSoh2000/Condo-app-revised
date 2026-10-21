import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { api } from '@/api/client';
import { Field } from '@/features/auth/components/Field';
import { PageHeading } from '@/features/auth/components/PageHeading';
import { codePoints, rateLimitMessage } from '@/features/auth/formErrors';

// As the login form: any non-empty string (app/auth/schemas.py::PasswordResetRequestIn takes a malformed
// address as an unknown one), at most 320 code points.
const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email.')
    .refine((value) => codePoints(value) <= 320, 'This email is too long.'),
});
type ForgotForm = z.infer<typeof schema>;

/**
 * Asks for a reset link. The answer is the server's one 202 text whatever the email, shown as is: the page
 * never says whether an account exists, so it can't be used to find out who has one (P4-04).
 */
export function ForgotPasswordPage() {
  const [sent, setSent] = useState<string | null>(null);
  // An object, so the same message twice is still a new value and moves focus again.
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotForm>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);
  // The form and its focused button are gone: focus the answer, not the body.
  useEffect(() => {
    if (sent !== null) statusRef.current?.focus();
  }, [sent]);

  const onSubmit = async (body: ForgotForm) => {
    setFailure(null);
    try {
      const { detail } = await api.post('/api/auth/password-reset/request', { body });
      setSent(detail);
    } catch (error) {
      setFailure({ message: rateLimitMessage(error) ?? 'Could not send the link. Try again.' });
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <PageHeading>Forgot your password?</PageHeading>
      {sent !== null ? (
        <div
          ref={statusRef}
          role="status"
          tabIndex={-1}
          data-testid="forgot-status"
          className="rounded border border-slate-300 bg-slate-50 p-3 text-sm"
        >
          {sent}
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-slate-600">Enter your email and we'll send you a link to choose a new one.</p>
          {failure && (
            <div
              ref={alertRef}
              role="alert"
              tabIndex={-1}
              data-testid="forgot-error"
              className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
            >
              {failure.message}
            </div>
          )}
          <form
            noValidate
            data-testid="forgot-form"
            onSubmit={(event) => void handleSubmit(onSubmit)(event)}
            className="flex flex-col gap-4"
          >
            <Field label="Email" id="email" error={errors.email?.message}>
              <input
                id="email"
                type="email"
                autoComplete="email"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? 'email-error' : undefined}
                data-testid="forgot-email"
                className="w-full rounded border px-3 py-2"
                {...register('email')}
              />
            </Field>
            <button
              type="submit"
              disabled={isSubmitting}
              data-testid="forgot-submit"
              className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              Send reset link
            </button>
          </form>
        </>
      )}
      <Link to="/login" className="mt-6 text-sm underline">
        Back to sign in
      </Link>
    </main>
  );
}
