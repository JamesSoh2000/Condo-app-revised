/**
 * The tab's choices, in sessionStorage: per tab, so two tabs can work in two buildings, and gone with the
 * tab. A stored value is only a preference: `BuildingProvider` uses the building only if it is one of
 * `/me`'s active memberships, and "view as" only applies to a council member. Storage that throws (privacy
 * modes, quota) counts as empty.
 */
const BUILDING_KEY = 'condo.buildingId';
const VIEW_KEY = 'condo.viewAs';

/** Council "view as" (P2-06c): which of the pages the member may open the navigation lists. */
export type ViewAs = 'management' | 'resident';

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Nothing to do: the choice still works for this page load.
  }
}

export const readSelectedBuilding = (): string | null => read(BUILDING_KEY);
export const writeSelectedBuilding = (id: string | null): void => write(BUILDING_KEY, id);

export function readViewAs(): ViewAs {
  return read(VIEW_KEY) === 'resident' ? 'resident' : 'management';
}
export const writeViewAs = (view: ViewAs): void => write(VIEW_KEY, view);

/** At logout, a 401 reset, login and a user change: the next user of the tab starts from nothing. */
export function clearTabChoices(): void {
  write(BUILDING_KEY, null);
  write(VIEW_KEY, null);
}
