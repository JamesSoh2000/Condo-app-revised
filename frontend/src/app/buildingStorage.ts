/**
 * The tab's selected building ID, in sessionStorage: per tab, so two tabs can work in two buildings, and
 * gone with the tab. A stored value is only a preference: `BuildingProvider` uses it only if it is one of
 * `/me`'s active memberships. Storage that throws (privacy modes, quota) counts as empty.
 */
const KEY = 'condo.buildingId';

export function readSelectedBuilding(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeSelectedBuilding(id: string | null): void {
  try {
    if (id === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, id);
  } catch {
    // Nothing to do: the selection still works for this page load.
  }
}

/** At logout, a 401 reset and login: the next user of the tab never starts in the previous one's building. */
export function clearSelectedBuilding(): void {
  writeSelectedBuilding(null);
}
