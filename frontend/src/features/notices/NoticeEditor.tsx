import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { codePoints, rateLimitMessage, serverFieldErrors } from '@/features/auth/formErrors';
import { FileUpload } from '@/features/files/FileUpload';
import type { UploadStatus } from '@/features/files/useUpload';
import { useSaveNotice, type Notice, type NoticeCreate, type NoticeUpdate } from '@/features/notices/api';
import { toInstant, toLocalInput } from '@/features/notices/expiry';
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
  expired: 'This time has passed. Choose a later one.',
  range: 'Choose a time before the year 9999.',
  invalidTime: 'Enter a date and time.',
  file: 'This file can’t be attached. Upload it again.',
  uploading: 'Wait for the attachment to finish uploading.',
  uploadFailed: 'The attachment didn’t upload. Retry it or remove it.',
  moved: 'This notice is no longer a draft: it was published or archived elsewhere. Your text is kept here to copy.',
};
type Field = 'title' | 'body' | 'priority' | 'expires_at' | 'attachment_file_id';
const FIELDS: readonly Field[] = ['title', 'body', 'priority', 'expires_at', 'attachment_file_id'];
// The API's own 422s (criterion 6); a type not listed can't be placed and shows as a form message.
const SERVER_MESSAGES: Partial<Record<Field, Record<string, string>>> = {
  title: { missing: M.title, string_too_short: M.title, string_too_long: M.titleLong, control_characters: M.titleBad },
  body: { missing: M.body, string_too_short: M.body, string_too_long: M.bodyLong, control_characters: M.bodyBad },
  expires_at: { datetime_range: M.range },
  attachment_file_id: { uuid_parsing: M.file },
};
const FILE_REFUSED = ['invalid_file', 'file_not_found'];
const INPUT = 'w-full min-w-0 rounded border px-3 py-2';

interface Upload {
  status: UploadStatus;
  // Only while `status` is `ready`.
  fileId: string | null;
}
const NO_UPLOAD: Upload = { status: 'idle', fileId: null };

interface Props {
  /** The draft to edit as its row showed it, or null for a new one. */
  item: Notice | null;
  /** The building's timezone: the expiry is a wall time there (criterion 4). */
  timeZone: string;
  onSaved: (notice: Notice, created: boolean) => void;
  /** Publish the saved draft (D3): the page closes the editor and asks P6-02c's confirm dialog. */
  onPublish: (notice: Notice) => void;
  onClose: () => void;
}

/**
 * Write a new draft or edit one (P6-02d): title, Markdown body with a preview through the feed's `NoticeBody`,
 * priority, an expiry in building time and one attachment. A save sends only what differs from the last saved version
 * (criterion 2); after it the editor stays on the saved draft, which it can then publish (D3).
 */
export function NoticeEditor({ item, timeZone, onSaved, onPublish, onClose }: Props) {
  const save = useSaveNotice(useBuildingId());
  const [saved, setSaved] = useState(item);
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [priority, setPriority] = useState<Notice['priority']>(item?.priority ?? 'normal');
  const [expiry, setExpiry] = useState(item?.expires_at ? toLocalInput(item.expires_at, timeZone) : '');
  // The saved attachment while kept; a finished upload replaces it.
  const [kept, setKept] = useState(item?.attachment_file_id ?? null);
  const [upload, setUpload] = useState<Upload>(NO_UPLOAD);
  // A new `FileUpload` (no file, no message) after a save, a Remove or a refused file.
  const [uploadInput, setUploadInput] = useState(0);
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

  const attachment = upload.status === 'ready' ? upload.fileId : kept;
  const savedExpiry = saved?.expires_at ? toLocalInput(saved.expires_at, timeZone) : '';
  const values = { title: pyStrip(title), body: pyStrip(body) };
  // What differs from the last save; for a new notice, everything it has.
  const changes: NoticeUpdate = {};
  if (values.title !== saved?.title) changes.title = values.title;
  if (values.body !== saved?.body) changes.body = values.body;
  if (priority !== (saved?.priority ?? 'normal') || !saved) changes.priority = priority;
  if (expiry !== savedExpiry) changes.expires_at = expiry ? toInstant(expiry, timeZone) : null;
  if (attachment !== (saved?.attachment_file_id ?? null)) changes.attachment_file_id = attachment;
  const dirty = saved ? Object.keys(changes).length > 0 : Boolean(title || body || expiry || attachment || upload.status !== 'idle');

  const problems: Partial<Record<Field, string>> = {
    title: TITLE_BAD.test(title) ? M.titleBad : !values.title ? M.title : codePoints(values.title) > TITLE_MAX ? M.titleLong : undefined,
    body: BODY_BAD.test(body) ? M.bodyBad : !values.body ? M.body : codePoints(values.body) > BODY_MAX ? M.bodyLong : undefined,
    expires_at: expiry && toInstant(expiry, timeZone) === null ? M.invalidTime : undefined,
    attachment_file_id: upload.status === 'uploading' ? M.uploading : upload.status === 'error' ? M.uploadFailed : undefined,
  };
  const shown = (field: Field) => errors[field] ?? (tried ? problems[field] : undefined);

  const onUploadStatus = useCallback((next: UploadStatus) => setUpload((current) => ({ status: next, fileId: next === 'ready' ? current.fileId : null })), []);
  const resetUpload = () => {
    setUpload(NO_UPLOAD);
    setUploadInput((n) => n + 1);
  };
  const edit = <T,>(set: (value: T) => void, field?: Field) => (value: T) => {
    set(value);
    setStatus('');
    if (field) setErrors(({ [field]: _, ...rest }) => rest);
  };

  function failed(error: unknown) {
    const code = error instanceof ApiError ? error.code : null;
    const placed = serverFieldErrors(error, FIELDS, SERVER_MESSAGES);
    let next: Partial<Record<Field, string>> = {};
    if (placed) next = Object.fromEntries(placed.map(({ field, message }) => [field, message]));
    else if (code === 'notice_expired') next = { expires_at: M.expired };
    else if (code !== null && FILE_REFUSED.includes(code)) {
      resetUpload();
      next = { attachment_file_id: M.file };
    } else if (code === 'notice_not_editable') setMoved(true);
    const first = FIELDS.find((field) => next[field]);
    setErrors(next);
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
      setExpiry(result.expires_at ? toLocalInput(result.expires_at, timeZone) : '');
      setKept(result.attachment_file_id);
      resetUpload();
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
        <fieldset className="min-w-0">
          <legend className="mb-1 text-sm font-medium">Priority</legend>
          <div className="flex flex-wrap gap-2">
            {(['normal', 'urgent'] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2 rounded border bg-white px-3">
                <input type="radio" name={`${id}-priority`} checked={priority === value} disabled={busy} onChange={() => edit(setPriority)(value)} />
                {value === 'normal' ? 'Normal' : 'Urgent'}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-expires_at`} className="text-sm font-medium">
            Expires (building time, optional)
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`${id}-expires_at`}
              type="datetime-local"
              value={expiry}
              readOnly={busy}
              onChange={(event) => edit(setExpiry, 'expires_at')(event.target.value)}
              aria-invalid={invalid('expires_at')}
              aria-describedby={describedBy('expires_at')}
              className={`${INPUT} sm:w-64`}
            />
            {expiry && (
              <button type="button" disabled={busy} onClick={() => edit(setExpiry, 'expires_at')('')} className="min-h-11 rounded border px-4 text-sm disabled:opacity-50">
                Remove expiry
              </button>
            )}
          </div>
          {fieldError('expires_at')}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Attachment (optional)</span>
          {kept !== null && upload.status === 'idle' && (
            <p className="text-sm">{saved?.attachment_content_type === 'application/pdf' ? 'A PDF is attached.' : 'An image is attached.'}</p>
          )}
          {/* `purpose` stays constant: `useUpload` keeps a failed form if it changes before Retry (P3-06 R3). */}
          <FileUpload
            key={uploadInput}
            purpose="notice_attachment"
            label="Choose file"
            onUploaded={(fileId) => edit(setUpload, 'attachment_file_id')({ status: 'ready', fileId })}
            onStatusChange={onUploadStatus}
            disabled={busy}
          />
          {(attachment !== null || upload.status === 'error') && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setKept(null);
                resetUpload();
                setErrors(({ attachment_file_id: _, ...rest }) => rest);
              }}
              className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50"
            >
              Remove attachment
            </button>
          )}
          {fieldError('attachment_file_id')}
        </div>
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
