import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { acceptFor, checkFile, contentTypeOf, describeRule, ruleFor, type FilePurpose } from '@/features/files/purposes';
import { useUpload, type UploadStatus } from '@/features/files/useUpload';

// Types every browser can draw; a HEIC preview would be a broken image in most of them.
const PREVIEWABLE = ['image/jpeg', 'image/png', 'image/webp'];

export interface FileUploadProps {
  purpose: FilePurpose;
  /** Called once per finished upload, with the `file_id` to send to the record that uses it. */
  onUploaded: (fileId: string) => void;
  /** Content types to allow, within the purpose's; defaults to all of them. */
  accept?: readonly string[];
  /** A lower size limit than the purpose's; a higher one is ignored. */
  maxBytes?: number;
  /** `environment` opens the back camera on phones (package photos). */
  capture?: 'environment' | 'user';
  label?: string;
  /** Called with each new status, so a form can wait for the upload (P5-03c). */
  onStatusChange?: (status: UploadStatus) => void;
}

/**
 * Chooses (button or drop) and uploads one file to private S3, with a preview, progress, cancel and retry. The
 * client check mirrors the server's rule so a wrong file fails before any request; the server still enforces it.
 */
export function FileUpload(props: FileUploadProps) {
  // Keyed, so a new purpose starts with no preview, error or progress (review round 3, R3-F1).
  return <FileUploadFor key={props.purpose} {...props} />;
}

function FileUploadFor({ purpose, onUploaded, accept, maxBytes, capture, label = 'Choose file', onStatusChange }: FileUploadProps) {
  const rule = useMemo(() => ruleFor(purpose, accept, maxBytes), [purpose, accept, maxBytes]);
  const { upload, retry, cancel, progress, status, error } = useUpload(purpose, { onUploaded });
  const [checkError, setCheckError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const preview = useObjectUrl(chosen && PREVIEWABLE.includes(contentTypeOf(chosen)) ? chosen : null);
  const busy = status === 'uploading';
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => onStatusChangeRef.current?.(status), [status]);
  const percent = Math.round(progress * 100);

  function start(file: File) {
    if (busy) return;
    const problem = checkFile(file, rule);
    setCheckError(problem);
    setChosen(problem ? null : file);
    if (problem) cancel();
    else upload(file);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) start(file);
  }

  const message = checkError ?? error;
  let announcement = '';
  // In quarter steps: every percent would flood a screen reader (review round 2, F3).
  if (busy) announcement = `Uploading ${chosen?.name ?? 'file'}… ${Math.floor(percent / 25) * 25}%`;
  else if (status === 'ready') announcement = `Uploaded ${chosen?.name ?? 'file'}.`;

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="file-drop-zone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-wrap items-center gap-2 rounded border-2 border-dashed p-3 ${dragging ? 'border-blue-600 bg-blue-50' : 'border-slate-300'}`}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="rounded border bg-white px-3 py-1 text-sm disabled:opacity-50"
        >
          {label}
        </button>
        <span className="text-xs text-slate-600">or drop it here ({describeRule(rule)})</span>
        <input
          ref={input}
          type="file"
          className="hidden"
          tabIndex={-1}
          accept={acceptFor(rule)}
          capture={capture}
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared, so choosing the same file again is a change too.
            event.target.value = '';
            if (file) start(file);
          }}
        />
      </div>
      {preview && chosen && (
        <img src={preview} alt={`Preview of ${chosen.name}`} className="max-h-40 w-fit rounded object-contain" />
      )}
      {busy && (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-2 flex-1 overflow-hidden rounded bg-slate-200"
          >
            <div className="h-full bg-blue-600" style={{ width: `${percent}%` }} />
          </div>
          <button type="button" onClick={cancel} className="rounded border px-2 py-0.5 text-xs">
            Cancel
          </button>
        </div>
      )}
      {message && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-red-800">
            {message}
          </p>
          {checkError === null && status === 'error' && (
            <button type="button" onClick={retry} className="rounded border px-2 py-0.5 text-xs">
              Retry
            </button>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className="text-sm text-slate-600">
        {announcement}
      </p>
    </div>
  );
}

/** An object URL for `file` while it is shown, revoked afterwards. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file === null) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url;
}
