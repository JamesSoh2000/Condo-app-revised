import type { components } from '@/api/schema';

export type FilePurpose = components['schemas']['FilePurpose'];

export interface FileRule {
  contentTypes: readonly string[];
  maxBytes: number;
}

const MiB = 1024 * 1024;
const IMAGE: FileRule = { contentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'], maxBytes: 10 * MiB };
const PDF: FileRule = { contentTypes: ['application/pdf'], maxBytes: 20 * MiB };

/**
 * A copy of the server's registry (backend `app/files/purposes.py::PURPOSES`), for a check before any request.
 * The server enforces it again; keyed by the generated `FilePurpose`, so a new purpose fails typecheck here.
 */
export const PURPOSE_RULES: Record<FilePurpose, FileRule> = {
  package_photo: IMAGE,
  maintenance_photo: IMAGE,
  notice_attachment: PDF,
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
 * The purpose's rule, narrowed by a caller's `accept` (content types) and `maxBytes`. A caller can only narrow
 * it: a wider limit would just move the error to the server.
 */
export function ruleFor(purpose: FilePurpose, accept?: readonly string[], maxBytes?: number): FileRule {
  const rule = PURPOSE_RULES[purpose];
  return {
    contentTypes: accept ? rule.contentTypes.filter((type) => accept.includes(type)) : rule.contentTypes,
    maxBytes: Math.min(rule.maxBytes, maxBytes ?? rule.maxBytes),
  };
}

/** The type to declare for `file`: the browser's, else one known from the extension, else ''. */
export function contentTypeOf(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[extension] ?? '';
}

/** The `accept` attribute for `rule`: its types, plus the extensions of types browsers may leave empty. */
export function acceptFor(rule: FileRule): string {
  const extensions = Object.entries(BY_EXTENSION)
    .filter(([, type]) => rule.contentTypes.includes(type))
    .map(([extension]) => `.${extension}`);
  return [...rule.contentTypes, ...extensions].join(',');
}

/** The rule in words: "JPEG, PNG, WebP or HEIC, up to 10 MB". */
export function describeRule(rule: FileRule): string {
  return `${typesLabel(rule)}, up to ${formatMegabytes(rule.maxBytes)}`;
}

/** What is wrong with `file` under `rule`, as a sentence for the user, or null when it may be uploaded. */
export function checkFile(file: File, rule: FileRule): string | null {
  if (!rule.contentTypes.includes(contentTypeOf(file))) return `This file must be a ${typesLabel(rule)} file.`;
  if (file.size === 0) return 'This file is empty.';
  if (file.size > rule.maxBytes) return `This file is larger than ${formatMegabytes(rule.maxBytes)}.`;
  return null;
}

function typesLabel(rule: FileRule): string {
  const names = rule.contentTypes.map((type) => TYPE_NAMES[type] ?? type);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? 'supported');
}

function formatMegabytes(bytes: number): string {
  return `${Math.round((bytes / MiB) * 10) / 10} MB`;
}
