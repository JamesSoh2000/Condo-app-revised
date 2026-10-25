import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { codePoints, rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import { useSaveNotice, type Notice, type NoticeCreate, type NoticeUpdate } from '@/features/notices/api';
import { NoticeBody } from '@/features/notices/NoticeBody';
import { Modal } from '@/features/residents/Modal';

// Python's `str.strip()` whitespace, which the server strips (`app/notices/schemas.py`); JavaScript's `trim` also
// strips U+FEFF, which Python keeps and counts.
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const EDGES = new RegExp(`^${SPACE}+|${SPACE}+$`, 'gu');
const pyStrip = (value: string) => value.replace(EDGES, '');
// The schema's `printable` (title) and `_markdown_before_strip` (body), plus lone surrogates, which pydantic refuses as
// `json_invalid`, with no field to show it on.
const TITLE_BAD = /[\p{Cc}\p{Cs}]/u;
const BODY_BAD = /\p{Cs}|(?![\t\n\r])\p{Cc}/u;

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const M = {
  title: 'Enter a title.',
  titleLong: `Use at most ${TITLE_MAX} characters.`,
  titleBad: 'Use visible characters only.',
  body: 'Enter the notice text.',
  bodyLong: 'Use at most 10 000 characters.',
  bodyBad: 'Use visible characters, tabs and line breaks only.',
  priority: 'Choose Normal or Urgent.',
  moved: 'This notice is no longer a draft: it was published or archived elsewhere. Your text is kept here to copy.',
};
// The expiry and the attachment come in P6-02f; a draft's own are kept, since an update sends only what changed.
type Field = 'title' | 'body' | 'priority';
const FIELDS: readonly Field[] = ['title', 'body', 'priority'];
// The API's own 422s (criterion 6); a type not listed can't be placed and shows as a form message.
const SERVER_MESSAGES: Partial<Record<Field, Record<string, string>>> = {
  title: { missing: M.title, string_too_short: M.title, string_too_long: M.titleLong, control_characters: M.titleBad },
  body: { missing: M.body, string_too_short: M.body, string_too_long: M.bodyLong, control_characters: M.bodyBad },
  priority: { missing: 'This field is required.', enum: M.priority },
};
const INPUT = 'w-full min-w-0 rounded border px-3 py-2';

interface Props {
  /** The draft to edit as its row showed it, or null for a new one. */
  item: Notice | null;
  onSaved: (notice: Notice, created: boolean) => void;
  /** Publish the saved draft (D3): the page closes the editor and asks P6-02c's confirm dialog. */
  onPublish: (notice: Notice) => void;
  onClose: () => void;
}

/**
 * Write a new draft or edit one (P6-02d): title, Markdown body with a preview through the feed's `NoticeBody`, and
 * priority. A save sends only what differs from the last saved version
 * (criterion 2); after it the editor stays on the saved draft, which it can then publish (D3).
 */
export function NoticeEditor({ item, onSaved, onPublish, onClose }: Props) {
  const save = useSaveNotice(useBuildingId());
  const [saved, setSaved] = useState(item);
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [priority, setPriority] = useState<Notice['priority']>(item?.priority ?? 'normal');
  const [preview, setPreview] = useState(false);
  const [tried, setTried] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // State, so the effect runs after the commit that shows the field's error or the message (as P6-02c's page).
  const [focusTo, setFocusTo] = useState<{ target: Field | 'status' | 'failure' } | null>(null);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    titleRef.current?.focus();
    return () => void (mounted.current = false);
  }, []);
  useEffect(() => {
    if (!focusTo) return;
    const { target } = focusTo;
    const element = target === 'status' ? statusRef.current : target === 'failure' ? failureRef.current : document.getElementById(`${id}-${target}`);
    element?.focus();
  }, [focusTo, id]);

  const values = { title: pyStrip(title), body: pyStrip(body) };
  // What differs from the last save; for a new notice, everything it has.
  const changes: NoticeUpdate = {};
  if (values.title !== saved?.title) changes.title = values.title;
  if (values.body !== saved?.body) changes.body = values.body;
  if (priority !== (saved?.priority ?? 'normal') || !saved) changes.priority = priority;
  const dirty = saved ? Object.keys(changes).length > 0 : Boolean(title || body || priority !== 'normal');

  const problems: Partial<Record<Field, string>> = {
    title: TITLE_BAD.test(title) ? M.titleBad : !values.title ? M.title : codePoints(values.title) > TITLE_MAX ? M.titleLong : undefined,
    body: BODY_BAD.test(body) ? M.bodyBad : !values.body ? M.body : codePoints(values.body) > BODY_MAX ? M.bodyLong : undefined,
  };
  const shown = (field: Field) => errors[field] ?? (tried ? problems[field] : undefined);

  const edit = <T,>(set: (value: T) => void, field?: Field) => (value: T) => {
    set(value);
    setStatus('');
    if (field) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  function failed(error: unknown) {
    const code = error instanceof ApiError ? error.code : null;
    const placed = serverFieldErrors(error, FIELDS, SERVER_MESSAGES);
    let next: Partial<Record<Field, string>> = {};
    if (placed) next = Object.fromEntries(placed.map(({ field, message }) => [field, message]));
    else if (code === 'notice_not_editable') setMoved(true);
    const first = FIELDS.find((field) => next[field]);
    setErrors(next);
    // The body's textarea isn't there in Preview (review round 1 F1).
    if (next.body) setPreview(false);
    if (first) return setFocusTo({ target: first });
    setFailure(
      code === 'notice_not_editable'
        ? M.moved
        : (rateLimitMessage(error) ??
            (error instanceof ApiError && error.status === 422 ? 'Check the details and try again.' : 'Could not save the notice. Your changes are kept; try again.')),
    );
    setFocusTo({ target: 'failure' });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setTried(true);
    setErrors({});
    setFailure(null);
    setStatus('');
    const first = FIELDS.find((field) => problems[field]);
    if (first) {
      setPreview(false);
      return setFocusTo({ target: first });
    }
    if (saved && !dirty) {
      setStatus('No changes to save.');
      return setFocusTo({ target: 'status' });
    }
    inFlight.current = true;
    setBusy(true);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      const result = saved
        ? await save.mutateAsync({ id: saved.id, body: changes })
        : await save.mutateAsync({ id: null, body: changes as NoticeCreate });
      if (!mounted.current) return;
      setSaved(result);
      setTitle(result.title);
      setBody(result.body);
      setPriority(result.priority);
      setTried(false);
      setStatus('Draft saved.');
      setFocusTo({ target: 'status' });
      onSaved(result, !saved);
    } catch (error) {
      if (mounted.current) failed(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const describedBy = (field: Field) => (shown(field) ? `${id}-${field}-error` : undefined);
  const fieldError = (field: Field) =>
    shown(field) && (
      <p id={`${id}-${field}-error`} className="text-sm text-red-700">
        {shown(field)}
      </p>
    );
  const invalid = (field: Field) => (shown(field) ? true : undefined);
  const canPublish = saved !== null && !dirty && !moved && !busy;
  const heading = saved ? 'Edit notice' : 'New notice';

  return (
    <Modal labelledBy={`${id}-heading`} busy={busy || dirty} onEscape={onClose} dialogRef={root} wide>
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {heading}
      </h2>
      <form noValidate onSubmit={(event) => void submit(event)} className="mt-3 flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-title`} className="text-sm font-medium">
            Title
          </label>
          <input
            ref={titleRef}
            id={`${id}-title`}
            value={title}
            readOnly={busy}
            onChange={(event) => edit(setTitle, 'title')(event.target.value)}
            aria-invalid={invalid('title')}
            aria-describedby={describedBy('title')}
            className={INPUT}
          />
          {fieldError('title')}
        </div>
        <div className="flex flex-col gap-1">
          <div role="group" aria-label="Body view" className="flex gap-2">
            {(['Write', 'Preview'] as const).map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={preview === (name === 'Preview')}
                onClick={() => setPreview(name === 'Preview')}
                className={`min-h-11 rounded px-4 text-sm font-medium ${preview === (name === 'Preview') ? 'bg-slate-900 text-white' : 'border'}`}
              >
                {name}
              </button>
            ))}
          </div>
          {preview ? (
            // What members will see (criterion 3): the stripped text the server stores, through the feed's renderer.
            <div data-testid="notice-preview" className="min-w-0 rounded border bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 font-medium">{values.title}</h3>
                {priority === 'urgent' && <span className="rounded bg-red-100 px-1.5 text-xs font-semibold text-red-800">Urgent</span>}
              </div>
              {values.body ? <NoticeBody markdown={values.body} /> : <p className="text-sm text-slate-600">Nothing to preview.</p>}
            </div>
          ) : (
            <>
              <label htmlFor={`${id}-body`} className="text-sm font-medium">
                Body (Markdown)
              </label>
              <textarea
                id={`${id}-body`}
                rows={10}
                value={body}
                readOnly={busy}
                onChange={(event) => edit(setBody, 'body')(event.target.value)}
                aria-invalid={invalid('body')}
                aria-describedby={describedBy('body')}
                className={INPUT}
              />
            </>
          )}
          {fieldError('body')}
        </div>
        {/* Focusable, so a server error on priority can move focus here. */}
        <fieldset id={`${id}-priority`} tabIndex={-1} aria-describedby={describedBy('priority')} className="min-w-0">
          <legend className="mb-1 text-sm font-medium">Priority</legend>
          <div className="flex flex-wrap gap-2">
            {(['normal', 'urgent'] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3">
                <input type="radio" name={`${id}-priority`} checked={priority === value} disabled={busy} onChange={() => edit(setPriority, 'priority')(value)} />
                {value === 'normal' ? 'Normal' : 'Urgent'}
              </label>
            ))}
          </div>
          {fieldError('priority')}
        </fieldset>
        {failure && (
          <div ref={failureRef} role="alert" tabIndex={-1} className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
            {failure}
          </div>
        )}
        <p ref={statusRef} role="status" tabIndex={-1} data-testid="editor-status" className="text-sm font-medium empty:hidden">
          {status}
        </p>
        {!canPublish && !moved && <p className="text-sm text-slate-600">Save your changes to publish.</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded border px-4 disabled:opacity-50">
            {dirty ? 'Cancel' : 'Close'}
          </button>
          {!moved && (
            <button type="submit" disabled={busy} className="min-h-11 rounded border px-4 font-medium disabled:opacity-50">
              Save draft
            </button>
          )}
          {canPublish && (
            <button type="button" onClick={() => onPublish(saved)} className="min-h-11 rounded bg-slate-900 px-4 font-medium text-white">
              Publish
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
