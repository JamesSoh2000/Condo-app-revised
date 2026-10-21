import { useState } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { Field } from '@/features/auth/components/Field';
import { PASSWORD_MIN_LENGTH, codePoints } from '@/features/auth/formErrors';

function lengthHint(value: string): string {
  const count = codePoints(value);
  if (count === 0) return `At least ${PASSWORD_MIN_LENGTH} characters`;
  if (count < PASSWORD_MIN_LENGTH) return `${count} of at least ${PASSWORD_MIN_LENGTH} characters`;
  return `${count} characters (at least ${PASSWORD_MIN_LENGTH})`;
}

/**
 * A new password's input: a "Show password" toggle, and a length hint counted as the server counts. The hint
 * is described by, not announced: a live region would speak on every keystroke. Errors (the form's or the
 * server's, mapped by the page) show under it like any field's.
 */
export function PasswordField({
  id,
  label,
  value,
  error,
  testId,
  registration,
}: {
  id: string;
  label: string;
  /** The field's current value, for the hint. */
  value: string;
  error?: string;
  testId: string;
  registration: UseFormRegisterReturn;
}) {
  const [shown, setShown] = useState(false);
  const hintId = `${id}-hint`;
  return (
    <Field label={label} id={id} error={error}>
      <div className="flex gap-2">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${id}-error` : hintId}
          data-testid={testId}
          className="min-w-0 flex-1 rounded border px-3 py-2"
          {...registration}
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-controls={id}
          data-testid={`${testId}-toggle`}
          onClick={() => setShown((value) => !value)}
          className="shrink-0 rounded border px-3 py-2 text-sm"
        >
          Show password
        </button>
      </div>
      <p id={hintId} className="text-sm text-slate-600">
        {lengthHint(value)}
      </p>
    </Field>
  );
}
