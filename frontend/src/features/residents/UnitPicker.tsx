import { useId, useState, type RefObject } from 'react';

import { ApiError } from '@/api/errors';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { DEBOUNCE_MS, RELATIONSHIPS, unitName, useDebounced } from '@/features/onboarding/api';
import { useUnitOptions, type Relationship } from '@/features/residents/api';

// `SearchText` (backend app/units/schemas.py) refuses control characters.
const SEARCH_INVALID = 'Search with visible characters only.';
const CONTROL = /\p{Cc}/u;
export const UNIT_GONE = 'That unit is no longer available. Choose another.';

/** The server refused the unit itself (another building's, deleted, deactivated): another can be picked. */
export const unitGone = (error: unknown) =>
  error instanceof ApiError &&
  ((error.status === 404 && error.code === 'unit_not_found') || (error.status === 409 && error.code === 'unit_inactive'));

/**
 * A unit searched as you type among the building's active ones (the join form's pattern; P4-08e's transfer, P4-08i's
 * invite). Not asked while `enabled` is false.
 */
export function useUnitPicker(buildingId: string, enabled = true) {
  const [search, setSearch] = useState('');
  // Checked before trimming, which would drop a leading or trailing tab (P4-08e review round 1, Codex F3).
  const invalidSearch = CONTROL.test(search);
  const typed = useDebounced(search, DEBOUNCE_MS);
  const term = typed.trim();
  const units = useUnitOptions(buildingId, term, enabled && !invalidSearch && !CONTROL.test(typed));
  const [unitId, setUnitId] = useState<string | null>(null);
  const options = units.data?.items ?? [];
  return {
    search,
    // Typing starts a new choice, as the join form (P4-08e criterion 8).
    setSearch: (value: string) => {
      setSearch(value);
      setUnitId(null);
    },
    invalidSearch,
    term,
    units,
    options,
    // Only a unit the list shows counts: one picked in an earlier list may not be in this one (P4-08e criterion 8).
    chosen: options.some((unit) => unit.id === unitId) ? unitId : null,
    choose: setUnitId,
    clear: () => {
      setSearch('');
      setUnitId(null);
    },
    /** The server said the unit went (another building's, deleted, deactivated): pick again from a fresh list. */
    unitGone: () => {
      setUnitId(null);
      void units.refetch();
    },
  };
}

interface PickerProps {
  picker: ReturnType<typeof useUnitPicker>;
  legend: string;
  busy: boolean;
  /** Show "Choose a unit." while none is chosen. */
  missing: boolean;
  searchRef?: RefObject<HTMLInputElement>;
  /** The search field's label; a page with two unit searches names them apart (P5-03c). */
  label?: string;
}

/** The search field and the units it found, as radio buttons, with the list's loading, empty and failed states. */
export function UnitPicker({ picker, legend, busy, missing, searchRef, label = 'Unit number' }: PickerProps) {
  const id = useId();
  const { units, options, term, chosen, invalidSearch } = picker;
  // A failed refresh shows above the units it kept, as the members list's (P4-08e review round 1, Codex F1).
  const unitsError = units.isError && (
    <p role="alert" className="text-sm text-red-700">
      {rateLimitMessage(units.error) ?? (units.data ? 'Could not refresh the units.' : 'Could not load the units.')}{' '}
      <button type="button" className="underline" onClick={() => void units.refetch()}>
        Try again
      </button>
    </p>
  );
  let list;
  if (units.isPending) list = <p role="status">Loading units…</p>;
  else if (units.isError && !units.data) list = null;
  else if (options.length === 0) {
    list = <p className="text-sm">{term ? `No active unit starts with “${term}”.` : 'This building has no active units.'}</p>;
  } else {
    list = options.map((unit) => (
      <label key={unit.id} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3 py-2 [overflow-wrap:anywhere]">
        <input type="radio" name={`${id}-unit`} checked={chosen === unit.id} disabled={busy} onChange={() => picker.choose(unit.id)} />
        {unitName(unit.tower, unit.label)}
      </label>
    ));
  }
  const showMissing = missing && chosen === null;
  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-search`} className="text-sm font-medium">
          {label}
        </label>
        <input
          ref={searchRef}
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          // `SearchText`: at most 20 characters.
          maxLength={20}
          value={picker.search}
          readOnly={busy}
          onChange={(event) => picker.setSearch(event.target.value)}
          aria-invalid={invalidSearch}
          aria-describedby={invalidSearch ? `${id}-search-error` : undefined}
          className="w-full min-w-0 rounded border px-3 py-2"
        />
        {invalidSearch && (
          <p id={`${id}-search-error`} className="text-sm text-red-700">
            {SEARCH_INVALID}
          </p>
        )}
      </div>
      {/* `min-w-0`: a fieldset is otherwise as wide as its widest unit name, past a phone's width (P5-03b R1 F1). */}
      <fieldset
        aria-invalid={showMissing}
        aria-describedby={showMissing ? `${id}-unit-error` : undefined}
        aria-busy={units.isFetching}
        className="min-w-0"
      >
        <legend className="mb-1 text-sm font-medium">{legend}</legend>
        {unitsError}
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">{list}</div>
        {showMissing && (
          <p id={`${id}-unit-error`} className="mt-1 text-sm text-red-700">
            Choose a unit.
          </p>
        )}
      </fieldset>
    </>
  );
}

interface RelationshipProps {
  value: Relationship | null;
  onChange: (value: Relationship) => void;
  busy: boolean;
  /** Show "Choose how they relate to the unit." while none is chosen. */
  missing: boolean;
  firstRef?: RefObject<HTMLInputElement>;
}

/** How a resident relates to the unit, as radio buttons. */
export function RelationshipField({ value, onChange, busy, missing, firstRef }: RelationshipProps) {
  const id = useId();
  const showMissing = missing && value === null;
  return (
    <fieldset aria-invalid={showMissing} aria-describedby={showMissing ? `${id}-error` : undefined}>
      <legend className="mb-1 text-sm font-medium">How they relate to the unit</legend>
      <div className="flex flex-col gap-2">
        {RELATIONSHIPS.map((option, index) => (
          <label key={option.value} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3 py-2">
            <input
              ref={index === 0 ? firstRef : undefined}
              type="radio"
              name={`${id}-relationship`}
              checked={value === option.value}
              disabled={busy}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {showMissing && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          Choose how they relate to the unit.
        </p>
      )}
    </fieldset>
  );
}
