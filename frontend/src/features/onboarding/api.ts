import { useQuery } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

type Relationship = components['schemas']['OccupancyRelationship'];

/**
 * How each relationship reads to a resident choosing one (P4-08 must-explain 3): who owns, who rents, who lives
 * with them. The values are `OccupancyRelationship`'s (ADR-0010).
 */
export const RELATIONSHIPS: readonly { value: Relationship; label: string; help: string }[] = [
  { value: 'owner', label: 'Owner', help: 'You own this unit, whether you live in it or rent it out.' },
  { value: 'tenant', label: 'Tenant', help: 'You rent this unit from its owner.' },
  {
    value: 'household',
    label: 'Household member',
    help: 'You live in this unit with its owner or tenant, for example as family or a roommate.',
  },
];

export const relationshipLabel = (value: Relationship): string =>
  RELATIONSHIPS.find((option) => option.value === value)?.label ?? value;

/** A unit as residents read it: `A-1203` in a building with towers, `1203` otherwise. */
export const unitName = (tower: string | null, label: string): string => (tower ? `${tower}-${label}` : label);

/**
 * The caller's own status in a building, pending and denied included, with their latest join request. The
 * endpoint checks only the caller's own membership, not an active one (P4-05a), so it is the one building
 * request the status screens make (P4-08 must-explain 1).
 */
export function useMyOnboarding(buildingId: string) {
  return useQuery({
    queryKey: ['b', buildingId, 'onboarding', 'me'],
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/onboarding/me', { params: { path: { building_id: buildingId } }, signal }),
  });
}
