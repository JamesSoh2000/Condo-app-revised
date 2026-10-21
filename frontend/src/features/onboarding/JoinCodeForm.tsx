import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Field } from '@/features/auth/components/Field';
import type { SignedInState } from '@/features/auth/pages/LoginPage';

const CODE = /^[A-Z0-9-]{1,16}$/;
const INVALID = 'Enter the join code or link your building gave you.';

/**
 * The join code in what a resident typed or pasted: the code itself in any case, or a link whose path has
 * `/join/<code>`. Codes are generated in capitals, and anything outside `app/onboarding/service.py::_JOIN_CODE`
 * can't be one. Null when there is no code to use.
 */
export function parseJoinCode(input: string): string | null {
  let value = input.trim();
  if (value.includes('/')) {
    const match = /\/join\/([^/?#]*)/i.exec(value);
    if (!match) return null;
    value = match[1];
  }
  value = value.toUpperCase();
  return CODE.test(value) ? value : null;
}

/** Opens the join page for a code, from inside the app: the user is signed in, so it skips the sign-up form. */
export function JoinCodeForm({ submitLabel }: { submitLabel: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = parseJoinCode(value);
    setInvalid(code === null);
    if (code !== null) navigate(`/join/${code}`, { state: { signedIn: true } satisfies SignedInState });
  };
  return (
    <form noValidate onSubmit={submit} className="mt-4 flex flex-col gap-3 text-left">
      <Field label="Join code or link" id="join-code" error={invalid ? INVALID : undefined}>
        <input
          id="join-code"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoCapitalize="characters"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? 'join-code-error' : undefined}
          className="w-full rounded border px-3 py-2"
        />
      </Field>
      <button type="submit" className="rounded bg-slate-900 px-4 py-2 font-medium text-white">
        {submitLabel}
      </button>
    </form>
  );
}
