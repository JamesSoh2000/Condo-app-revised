import type { MaintenanceCategory, MaintenanceRequest, MaintenanceStatus } from '@/features/maintenance/api';
import { unitName } from '@/features/onboarding/api';

/** Each status in words, so a card never says it by colour alone (P6-04a criterion 1); P6-04c and P6-04d reuse it. */
export const STATUS_LABEL: Record<MaintenanceStatus, string> = {
  submitted: 'Submitted',
  in_progress: 'In progress',
  on_hold: 'On hold',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

/** Each category in words; P6-04b's form offers them in this order. */
export const CATEGORY_LABEL: Record<MaintenanceCategory, string> = {
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  heating_cooling: 'Heating and cooling',
  appliance: 'Appliance',
  doors_windows: 'Doors and windows',
  pest_control: 'Pest control',
  other: 'Other',
  emergency: 'Emergency',
};

/** Where the work is: "Unit A-101", or the common area as the resident described it. */
export function requestLocation(item: MaintenanceRequest): string {
  if (item.location === 'common_area') return item.common_area ?? 'A common area';
  return item.unit_label ? `Unit ${unitName(item.unit_tower, item.unit_label)}` : 'Your unit';
}

const FIRST_LINE_MAX = 120;

/** A description's first line, cut at 120 characters (not UTF-16 units, so no emoji is split) with "…". */
export function firstLine(description: string): string {
  const chars = Array.from(description.split(/\r?\n/, 1)[0]);
  return chars.length > FIRST_LINE_MAX ? `${chars.slice(0, FIRST_LINE_MAX).join('')}…` : chars.join('');
}
