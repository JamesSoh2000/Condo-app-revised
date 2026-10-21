import { ApiError } from '@/api/errors';

/** The server counts characters with Python's `len()`, code points; JavaScript's length counts UTF-16 units. */
export const codePoints = (value: string): number => [...value].length;

/** `app/core/security.py`'s policy: 12–128 characters, no composition rules. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_TOO_SHORT = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_TOO_LONG = `Use at most ${PASSWORD_MAX_LENGTH} characters.`;

/** "30 seconds", "10 minutes": a `Retry-After` for people. */
export function waitText(seconds: number): string {
  return seconds < 120 ? `${seconds} second${seconds === 1 ? '' : 's'}` : `${Math.ceil(seconds / 60)} minutes`;
}

/** The message for a 429, with the wait time when the server sent one; null for any other error. */
export function rateLimitMessage(error: unknown, lead = 'Too many requests.'): string | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  return error.retryAfter ? `${lead} Try again in ${waitText(error.retryAfter)}.` : `${lead} Try again later.`;
}

// One message per `errors[].type`: the policy's own (`password_<reason>`, app/core/security.py) and pydantic's
// for the same limits, which the confirm's schema checks first (`string_too_short`/`_long`).
const FIELD_MESSAGES: Record<string, string> = {
  missing: 'This field is required.',
  password_too_short: PASSWORD_TOO_SHORT,
  string_too_short: PASSWORD_TOO_SHORT,
  password_too_long: PASSWORD_TOO_LONG,
  string_too_long: PASSWORD_TOO_LONG,
  password_too_common: 'This password is too common. Choose another.',
  password_invalid_characters: "This password contains characters that can't be used.",
};

export interface FieldError<F extends string> {
  field: F;
  message: string;
}

/**
 * A 422 `validation_error`'s `errors[]` placed on the form's fields: each error whose `loc` is
 * `["body", <one of fields>]` and whose type has a message. Null when nothing can be placed (another status,
 * an unknown field or type, no errors), so the caller shows a form-level message instead. Never the
 * server's `msg`: the client words its own messages.
 */
export function serverFieldErrors<F extends string>(error: unknown, fields: readonly F[]): FieldError<F>[] | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.errors?.length) return null;
  const placed: FieldError<F>[] = [];
  for (const { loc, type } of error.errors) {
    const field = loc.length === 2 && loc[0] === 'body' ? fields.find((name) => name === loc[1]) : undefined;
    const message = FIELD_MESSAGES[type];
    if (field === undefined || message === undefined) return null;
    placed.push({ field, message });
  }
  return placed;
}
