import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { runAuthCall } from '@/app/authQueue';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { DEBOUNCE_MS, RELATIONSHIPS, unitName, useDebounced } from '@/features/onboarding/api';

type Relationship = components['schemas']['OccupancyRelationship'];
export type JoinRequest = components['schemas']['OnboardingRequestOut'];
/** Where a refused request leads: the page shows a screen for each. */
export type Refusal = 'invalid' | 'member' | 'not-eligible';

function refusalFor(error: unknown): Refusal | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404 && error.code === 'join_code_invalid') return 'invalid';
  if (error.status === 409 && error.code === 'already_member') return 'member';
  if (error.status === 409 && error.code === 'membership_not_eligible') return 'not-eligible';
  return null;
}

interface Props {
  code: string;
  mounted: { readonly current: boolean };
  /** `active`: whether the user, per a fresh `/me`, has an active membership (null if `/me` failed). */
  onSent: (request: JoinRequest, active: boolean | null) => void;
  onRefused: (refusal: Refusal) => void;
}

/** The unit (searched as the user types) and the relationship, then the join request (`onboarding_create_request`). */
export function JoinRequestForm({ code, mounted, onSent, onRefused }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), DEBOUNCE_MS);
  const units = useQuery({
    queryKey: ['join', code, 'units', term],
    queryFn: ({ signal }) =>
      api.get('/api/join/{join_code}/units', { params: { path: { join_code: code }, query: { search: term } }, signal }),
    placeholderData: keepPreviousData,
  });
  const [unitId, setUnitId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [missing, setMissing] = useState({ unit: false, relationship: false });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);
  // Ahead of the button's `disabled`, which a second submit in the same tick doesn't see yet.
  const inFlight = useRef(false);

  const options = units.data ?? [];
  // Only a unit the list shows counts: one clicked in the previous results while a search was on its way may not
  // be among the new ones.
  const chosen = options.some((unit) => unit.id === unitId) ? unitId : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    setMissing({ unit: chosen === null, relationship: relationship === null });
    if (chosen === null || relationship === null) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    let sent: JoinRequest;
    try {
      sent = await api.post('/api/join/{join_code}/requests', {
        params: { path: { join_code: code } },
        body: { unit_id: chosen, relationship },
      });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const refusal = refusalFor(error);
      if (refusal) return onRefused(refusal);
      if (error instanceof ApiError && error.status === 404 && error.code === 'unit_not_found') {
        setUnitId(null);
        void units.refetch();
        return setFailure({ message: 'That unit is no longer available. Choose another.' });
      }
      return setFailure({ message: rateLimitMessage(error) ?? 'Could not send your request. Try again.' });
    }
    // The status screens ask again for this building's request.
    queryClient.removeQueries({ queryKey: ['b', sent.building_id, 'onboarding', 'me'] });
    if (!mounted.current) {
      void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
      return;
    }
    // A fresh /me, queued like the login page's (a logout in flight answers first): the guard reads the pending
    // membership from it, and it tells whether `/` would show the pending screen (D3). Through the shared `['me']`
    // query, not a side fetch: an older one still out is cancelled first, and a newer one (the shell's, after the
    // user left) cancels this one, so the cache never goes back to an older answer (review round 1, M1).
    let active: boolean | null = null;
    try {
      const me = await runAuthCall(async (signal) => {
        const cancel = () => void queryClient.cancelQueries({ queryKey: ['me'], exact: true });
        signal.addEventListener('abort', cancel, { once: true });
        await queryClient.cancelQueries({ queryKey: ['me'], exact: true });
        return queryClient.fetchQuery({
          queryKey: ['me'],
          queryFn: ({ signal: querySignal }) => api.get('/api/auth/me', { signal: querySignal }),
          staleTime: 0,
        });
      });
      active = me.memberships.some((m) => m.status === 'active');
    } catch {
      void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
    }
    if (mounted.current) onSent(sent, active);
  };

  let list;
  if (units.isPending) list = <p role="status">Loading units…</p>;
  else if (units.isError && !units.data) {
    list = (
      <p role="alert" className="text-sm text-red-700">
        {rateLimitMessage(units.error) ?? 'Could not load the units.'}{' '}
        <button type="button" className="underline" onClick={() => void units.refetch()}>
          Try again
        </button>
      </p>
    );
  } else if (options.length === 0) {
    list = <p>{term ? `No unit starts with “${term}”.` : 'This building has no units to choose from yet.'}</p>;
  } else {
    list = options.map((unit) => (
      <label key={unit.id} className="flex items-center gap-2 rounded border bg-white px-3 py-2">
        <input type="radio" name="unit" checked={chosen === unit.id} onChange={() => setUnitId(unit.id)} />
        {unitName(unit.tower, unit.label)}
      </label>
    ));
  }

  return (
    <form noValidate data-testid="join-request-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} data-testid="join-error" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {failure.message}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="unit-search" className="text-sm font-medium">
          Unit number
        </label>
        <input
          id="unit-search"
          type="search"
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setUnitId(null);
          }}
          aria-describedby="unit-search-help"
          className="w-full rounded border px-3 py-2"
        />
        <p id="unit-search-help" className="text-sm text-slate-600">
          Start typing your unit number, then choose it below.
        </p>
      </div>
      <fieldset aria-describedby={missing.unit ? 'unit-error' : undefined} aria-busy={units.isFetching}>
        <legend className="mb-1 text-sm font-medium">Your unit</legend>
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">{list}</div>
        {missing.unit && chosen === null && (
          <p id="unit-error" className="mt-1 text-sm text-red-700">
            Choose your unit.
          </p>
        )}
      </fieldset>
      <fieldset aria-describedby={missing.relationship ? 'relationship-error' : undefined}>
        <legend className="mb-1 text-sm font-medium">How you relate to the unit</legend>
        <div className="flex flex-col gap-2">
          {RELATIONSHIPS.map((option) => (
            <div key={option.value} className="flex items-start gap-2 rounded border bg-white px-3 py-2">
              <input
                type="radio"
                id={`relationship-${option.value}`}
                name="relationship"
                className="mt-1"
                checked={relationship === option.value}
                onChange={() => setRelationship(option.value)}
                aria-describedby={`relationship-${option.value}-help`}
              />
              <div>
                <label htmlFor={`relationship-${option.value}`} className="font-medium">
                  {option.label}
                </label>
                <p id={`relationship-${option.value}-help`} className="text-sm text-slate-600">
                  {option.help}
                </p>
              </div>
            </div>
          ))}
        </div>
        {missing.relationship && relationship === null && (
          <p id="relationship-error" className="mt-1 text-sm text-red-700">
            Choose how you relate to the unit.
          </p>
        )}
      </fieldset>
      <button type="submit" disabled={busy} className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">
        Send request
      </button>
    </form>
  );
}
