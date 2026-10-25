import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';
import { useNoticeAction, type Notice, type NoticeAction } from '@/features/notices/api';
import { Modal } from '@/features/residents/Modal';

const WORDS: Record<NoticeAction, { title: string; confirm: string; done: string; moved: string; failed: string }> = {
  publish: {
    title: 'Publish this notice?',
    confirm: 'Publish',
    done: 'published',
    moved: 'This notice is no longer a draft: it was published or archived elsewhere.',
    failed: 'Could not publish the notice. Try again.',
  },
  archive: {
    title: 'Archive this notice?',
    confirm: 'Archive',
    done: 'archived',
    moved: 'This notice was already archived elsewhere.',
    failed: 'Could not archive the notice. Try again.',
  },
};
const EXPIRED = 'This notice’s expiry has passed. Change it before publishing.';

interface Props {
  action: NoticeAction;
  /** The notice as the row showed it when the dialog opened; a refresh doesn't change it. */
  item: Notice;
  /** The outcome message after a success, null after Cancel or Escape. */
  onClose: (message: string | null) => void;
}

/**
 * Publish a draft or archive a draft or published notice (P6-02c criteria 2–4). One request per confirm: the guard is
 * taken before anything else, ahead of the buttons' `disabled`, which a second click in the same tick doesn't see yet.
 * Unlike the packages dialogs, every refusal (409, 422, any other) keeps the dialog open with its message, since the
 * criteria say so; the lists are asked again either way (`useNoticeAction`).
 */
export function NoticeActionDialog({ action, item, onClose }: Props) {
  const mutation = useNoticeAction(useBuildingId());
  const words = WORDS[action];
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    root.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    // The button about to be disabled would drop focus to <body> in a browser.
    root.current?.focus();
    try {
      await mutation.mutateAsync({ id: item.id, action });
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      const code = error instanceof ApiError ? error.code : null;
      setFailure(code === 'invalid_transition' ? words.moved : code === 'notice_expired' ? EXPIRED : (rateLimitMessage(error) ?? words.failed));
      return;
    }
    if (mounted.current) onClose(`“${item.title}” was ${words.done}.`);
  };

  return (
    <Modal labelledBy={titleId} busy={busy} onEscape={() => onClose(null)} dialogRef={root}>
      <h2 id={titleId} className="text-lg font-semibold">
        {words.title}
      </h2>
      <p className="mt-2 text-sm font-medium">{item.title}</p>
      {failure && (
        <div ref={alertRef} role="alert" tabIndex={-1} className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {failure}
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => onClose(null)} className="min-h-11 rounded border px-4 disabled:opacity-50">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="min-h-11 rounded bg-slate-900 px-4 font-medium text-white disabled:opacity-50"
        >
          {words.confirm}
        </button>
      </div>
    </Modal>
  );
}
