import { z } from 'zod';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  codePoints,
} from '@/features/auth/formErrors';

const NAME_REQUIRED = 'Enter your full name.';
const NAME_TOO_LONG = 'Use at most 200 characters.';
const NAME_CONTROL = "The name can't contain line breaks or other control characters.";

/**
 * A new account's fields, shared by the invitation's form and the join page's sign-up. The name as
 * app/auth/schemas.py::FullName: control characters refused before the strip, 1–200 code points after. The password
 * as on the reset page: not trimmed, and the server's common-password check comes back as a 422.
 */
const accountFields = {
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
};

/** The account fields plus `extra`, with the confirm checked against the password. */
export function accountSchema<T extends z.ZodRawShape>(extra: T) {
  return z
    .object({ ...accountFields, ...extra })
    .refine((form) => form.confirm === form.password, { message: "The passwords don't match.", path: ['confirm'] });
}

/** The server's 422 types on `full_name`, in these forms' words; the password's are formErrors' own. */
export const NAME_SERVER_MESSAGES = {
  missing: NAME_REQUIRED,
  string_too_short: NAME_REQUIRED,
  string_too_long: NAME_TOO_LONG,
  control_characters: NAME_CONTROL,
};
