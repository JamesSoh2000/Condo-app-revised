import { useCallback, useEffect, useRef, type Dispatch, type ReactNode, type SetStateAction } from 'react';

import { FileUpload } from '@/features/files/FileUpload';
import type { UploadStatus } from '@/features/files/useUpload';

/** `MAX_PHOTOS` (backend app/maintenance/models.py). */
export const MAX_PHOTOS = 5;

export interface Photo {
  /** The row's own, so a removed row's upload is cancelled (`FileUpload` unmounts) and the others keep theirs. */
  id: number;
  status: UploadStatus;
  // Only while `status` is `ready`: a new upload or a failed one never sends the last file (as `LogPackageForm`).
  fileId: string | null;
}

let nextId = 0;

interface Props {
  photos: Photo[];
  setPhotos: Dispatch<SetStateAction<Photo[]>>;
  busy: boolean;
  /** The id of the text a refused submit shows for the photos (`aria-describedby`). */
  hintId: string;
  hint: string | null;
  children?: ReactNode;
}

/**
 * Up to five photos for a request (P6-04b criterion 3), one `FileUpload` per row since it takes one file. "Add a photo"
 * adds a row and focuses its button; Remove takes the row away, its upload with it, and focus goes to "Add a photo",
 * which stays. The form sends the `ready` rows' file ids in row order.
 */
export function PhotoList({ photos, setPhotos, busy, hintId, hint, children }: Props) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const focusRow = useRef<number | null>(null);
  const full = photos.length >= MAX_PHOTOS;

  useEffect(() => {
    if (focusRow.current === null) return;
    rowsRef.current?.querySelector<HTMLButtonElement>(`[data-photo="${focusRow.current}"] button`)?.focus();
    focusRow.current = null;
  }, [photos]);

  const update = useCallback(
    (id: number, change: (photo: Photo) => Photo) => setPhotos((rows) => rows.map((row) => (row.id === id ? change(row) : row))),
    [setPhotos],
  );

  function add() {
    const id = (nextId += 1);
    focusRow.current = id;
    setPhotos((rows) => [...rows, { id, status: 'idle', fileId: null }]);
  }

  function remove(id: number) {
    setPhotos((rows) => rows.filter((row) => row.id !== id));
    addRef.current?.focus();
  }

  return (
    <fieldset aria-describedby={hint ? hintId : undefined} className="flex min-w-0 flex-col gap-2">
      <legend className="text-sm font-medium">Photos (optional)</legend>
      <div ref={rowsRef} className="flex min-w-0 flex-col gap-3">
        {photos.map((photo, index) => (
          <PhotoRow key={photo.id} photo={photo} n={index + 1} busy={busy} update={update} remove={remove} />
        ))}
      </div>
      <button
        ref={addRef}
        type="button"
        disabled={busy || full}
        aria-describedby={full ? `${hintId}-full` : undefined}
        onClick={add}
        className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50"
      >
        Add a photo
      </button>
      {full && (
        <p id={`${hintId}-full`} className="text-sm text-slate-700">
          A request takes at most {MAX_PHOTOS} photos.
        </p>
      )}
      {hint && (
        <p id={hintId} className="text-sm text-red-700">
          {hint}
        </p>
      )}
      {children}
    </fieldset>
  );
}

interface RowProps {
  photo: Photo;
  n: number;
  busy: boolean;
  update: (id: number, change: (photo: Photo) => Photo) => void;
  remove: (id: number) => void;
}

function PhotoRow({ photo, n, busy, update, remove }: RowProps) {
  const { id } = photo;
  const onStatusChange = useCallback(
    (status: UploadStatus) => update(id, (row) => ({ ...row, status, fileId: status === 'ready' ? row.fileId : null })),
    [id, update],
  );
  return (
    <div role="group" aria-label={`Photo ${n}`} data-photo={id} className="flex min-w-0 flex-col gap-2 rounded border p-2">
      <FileUpload
        purpose="maintenance_photo"
        capture="environment"
        label={`Choose photo ${n}`}
        onUploaded={(fileId) => update(id, (row) => ({ ...row, status: 'ready', fileId }))}
        onStatusChange={onStatusChange}
        disabled={busy}
      />
      <button type="button" disabled={busy} onClick={() => remove(id)} className="min-h-11 self-start rounded border px-4 text-sm disabled:opacity-50">
        Remove photo {n}
      </button>
    </div>
  );
}
