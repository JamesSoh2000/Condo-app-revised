import type { components } from '@/api/schema';

export type FilePurpose = components['schemas']['FilePurpose'];

export interface FileRule {
  /** Each accepted content type with its own size limit, as the server's `PurposeRule.limits` (ADR-0007 "Limits"). */
  limits: Readonly<Record<string, number>>;
}

const MiB = 1024 * 1024;
const IMAGE = { 'image/jpeg': 10 * MiB, 'image/png': 10 * MiB, 'image/webp': 10 * MiB, 'image/heic': 10 * MiB };
const PDF = { 'application/pdf': 20 * MiB };

/**
 * A copy of the server's registry (backend `app/files/purposes.py::PURPOSES`), for a check before any request.
 * The server enforces it again; keyed by the generated `FilePurpose`, so a new purpose fails typecheck here.
 */
export const PURPOSE_RULES: Record<FilePurpose, FileRule> = {
  package_photo: { limits: IMAGE },
  maintenance_photo: { limits: IMAGE },
  notice_attachment: { limits: { ...PDF, ...IMAGE } },
};

const TYPE_NAMES: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/heic': 'HEIC',
  'application/pdf': 'PDF',
};

// Browsers often give HEIC photos no type at all (Chrome and Firefox on desktop).
const BY_EXTENSION: Record<string, string> = { heic: 'image/heic' };

/**
 * The purpose's rule, narrowed by a caller's `accept` (content types) and `maxBytes` (each type's limit). A caller can
 * only narrow it: a wider limit would just move the error to the server.
 */
export function ruleFor(purpose: FilePurpose, accept?: readonly string[], maxBytes?: number): FileRule {
  const limits = Object.entries(PURPOSE_RULES[purpose].limits)
    .filter(([type]) => !accept || accept.includes(type))
    .map(([type, limit]) => [type, Math.min(limit, maxBytes ?? limit)]);
  return { limits: Object.fromEntries(limits) };
}

/** The type to declare for `file`: the browser's, else one known from the extension, else ''. */
export function contentTypeOf(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[extension] ?? '';
}

/** The `accept` attribute for `rule`: its types, plus the extensions of types browsers may leave empty. */
export function acceptFor(rule: FileRule): string {
  const types = Object.keys(rule.limits);
  const extensions = Object.entries(BY_EXTENSION)
    .filter(([, type]) => types.includes(type))
    .map(([extension]) => `.${extension}`);
  return [...types, ...extensions].join(',');
}

/**
 * The rule in words: "JPEG, PNG, WebP or HEIC, up to 10 MB" for one limit; with several, each group of types with its
 * own, "PDF up to 20 MB, or JPEG, PNG, WebP or HEIC up to 10 MB".
 */
export function describeRule(rule: FileRule): string {
  const groups = new Map<number, string[]>();
  for (const [type, limit] of Object.entries(rule.limits)) groups.set(limit, [...(groups.get(limit) ?? []), type]);
  if (groups.size === 1) return `${typesLabel(Object.keys(rule.limits))}, up to ${formatMegabytes([...groups.keys()][0])}`;
  return [...groups].map(([limit, types]) => `${typesLabel(types)} up to ${formatMegabytes(limit)}`).join(', or ');
}

/** What is wrong with `file` under `rule`, as a sentence for the user, or null when it may be uploaded. */
export function checkFile(file: File, rule: FileRule): string | null {
  const limit = rule.limits[contentTypeOf(file)];
  if (limit === undefined) return `This file must be a ${typesLabel(Object.keys(rule.limits))} file.`;
  if (file.size === 0) return 'This file is empty.';
  if (file.size > limit) return `This file is larger than ${formatMegabytes(limit)}.`;
  return null;
}

function typesLabel(types: readonly string[]): string {
  const names = types.map((type) => TYPE_NAMES[type] ?? type);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? 'supported');
}

function formatMegabytes(bytes: number): string {
  return `${Math.round((bytes / MiB) * 10) / 10} MB`;
}
