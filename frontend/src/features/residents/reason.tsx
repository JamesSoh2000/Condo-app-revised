import { useId, type RefObject } from 'react';

import { codePoints } from '@/features/auth/formErrors';

const TOO_SHORT = 'Give a reason of at least 3 characters.';
const TOO_LONG = 'Use at most 500 characters.';
const NOT_VISIBLE = 'Write the reason on one line, with visible characters only.';
// `Reason` (backend app/onboarding/schemas.py, also the members' suspend and move-out reason): no control, format or
// line/paragraph separator characters, checked before the strip; then 3–500 code points.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A 422 on `reason`, by its `type`, for `serverFieldErrors`. */
export const REASON_MESSAGES: Record<string, string> = {
  string_too_short: TOO_SHORT,
  string_too_long: TOO_LONG,
  control_characters: NOT_VISIBLE,
  invisible_characters: NOT_VISIBLE,
};

export function reasonError(value: string): string | null {
  if (INVISIBLE.test(value)) return NOT_VISIBLE;
  const length = codePoints(value.trim());
  if (length < 3) return TOO_SHORT;
  return length > 500 ? TOO_LONG : null;
}

interface Props {
  label: string;
  value: string;
  error: string | null;
  busy: boolean;
  fieldRef: RefObject<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  /** In UTF-16 units, twice the code points allowed; the caller counts as the server does. */
  maxLength?: number;
}

/** The reason textarea of a dialog, with its error below it. */
export function ReasonField({ label, value, error, busy, fieldRef, onChange, maxLength = 1000 }: Props) {
  const id = useId();
  return (
    <div className="mt-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        ref={fieldRef}
        id={id}
        rows={3}
        // 500 code points take at most 1,000 UTF-16 units; `reasonError` counts as the server does.
        maxLength={maxLength}
        value={value}
        readOnly={busy}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        className="w-full rounded border px-3 py-2"
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
