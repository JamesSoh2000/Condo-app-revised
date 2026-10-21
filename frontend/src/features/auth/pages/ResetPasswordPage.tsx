import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { clearTabChoices } from '@/app/buildingStorage';
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

// Not trimmed: spaces are part of a password (app/auth/schemas.py::PasswordResetConfirmIn). The server also
// refuses common passwords; only it knows the list, so that comes back as a 422 on the field.
const schema = z
  .object({
    new_password: z
      .string()
      .refine((value) => codePoints(value) >= PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT)
      .refine((value) => codePoints(value) <= PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG),
    confirm: z.string(),
  })
  .refine((form) => form.confirm === form.new_password, { message: "The passwords don't match.", path: ['confirm'] });
type ResetForm = z.infer<typeof schema>;

/** Router state the login page reads for its banner: never the URL, so a link can't show it (D2). */
export interface LoginState {
  passwordUpdated?: boolean;
}

/**
 * One screen per history entry: React would otherwise keep this page's state when only the URL changes (another
 * link, or Back to an entry of the same link), so an answer for the entry left behind would navigate from the
 * new one, and its invalid-link screen or field errors would show there (review round 1, F1).
 */
export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const { key } = useLocation();
  return <ResetPasswordScreen key={key} token={token} />;
}

/**
 * Sets a new password with the emailed token (P4-04). Success logs out every session on the server, so the
 * tab forgets everything cached and goes to the login page. Every bad token is one 400, shown as one screen;
 * a refused password keeps the form, and the link stays usable.
 */
function ResetPasswordScreen({ token }: { token: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [invalid, setInvalid] = useState(false);
  // An object, so the same message twice is still a new value and moves focus again.
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  // False once the page is gone (Back): a reset that answers later must not navigate.
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
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({ resolver: zodResolver(schema), defaultValues: { new_password: '', confirm: '' } });

  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  // A submit event while one is in flight (the button is disabled, but a script or an old browser can still
  // submit) sends nothing: the first answer decides.
  const inFlight = useRef(false);
  const onSubmit = async ({ new_password }: ResetForm) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    try {
      await api.post('/api/auth/password-reset/confirm', { body: { token, new_password } });
    } catch (error) {
      inFlight.current = false;
      if (error instanceof ApiError && error.status === 400 && error.code === 'reset_token_invalid') {
        setInvalid(true);
        return;
      }
      const placed = serverFieldErrors(error, ['new_password'] as const);
      if (placed) {
        placed.forEach(({ field, message }, index) => setError(field, { message }, { shouldFocus: index === 0 }));
        return;
      }
      setFailure({ message: rateLimitMessage(error) ?? 'Could not set the password. Try again.' });
      return;
    }
    // Every session of the account is gone, this tab's included: nothing cached may outlive it.
    queryClient.clear();
    clearTabChoices();
    if (mounted.current) navigate('/login', { replace: true, state: { passwordUpdated: true } satisfies LoginState });
  };

  if (invalid) {
    // Its own key: otherwise React keeps the form's <main> and heading, the heading's mount effect doesn't run
    // again, and focus falls to the body with the form's button.
    return (
      <main key="invalid" data-testid="reset-invalid" className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <PageHeading>This reset link is no longer valid</PageHeading>
        <p className="mb-4 text-sm">Links work once and expire. Request a new one to choose your password.</p>
        <Link to="/forgot-password" className="underline">
          Request a new link
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <PageHeading>Choose a new password</PageHeading>
      {failure && (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          data-testid="reset-error"
          className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {failure.message}
        </div>
      )}
      <form
        noValidate
        data-testid="reset-form"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        className="flex flex-col gap-4"
      >
        <PasswordField
          id="new_password"
          label="New password"
          value={watch('new_password')}
          error={errors.new_password?.message}
          testId="reset-password"
          registration={register('new_password')}
        />
        <PasswordField
          id="confirm"
          label="Confirm new password"
          value={watch('confirm')}
          error={errors.confirm?.message}
          testId="reset-confirm"
          registration={register('confirm')}
        />
        <button
          type="submit"
          disabled={isSubmitting}
          data-testid="reset-submit"
          className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          Set new password
        </button>
      </form>
    </main>
  );
}
