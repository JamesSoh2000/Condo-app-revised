import { useEffect, useRef, useState } from 'react';

import { useBuilding, useBuildingId } from '@/app/BuildingProvider';
import type { ManagedStatus, Notice, NoticeAction } from '@/features/notices/api';
import { ManagerNoticeList } from '@/features/notices/ManagerNoticeList';
import { NoticeActionDialog } from '@/features/notices/NoticeActionDialog';
import { NoticeEditor } from '@/features/notices/NoticeEditor';
import { buildingTime, useNow } from '@/features/packages/time';

const LISTS: { status: ManagedStatus; label: string; empty: string }[] = [
  { status: 'draft', label: 'Drafts', empty: 'No drafts.' },
  { status: 'published', label: 'Published', empty: 'No published notices.' },
  { status: 'archived', label: 'Archived', empty: 'No archived notices.' },
];

interface Open {
  action: NoticeAction;
  item: Notice;
  opener: HTMLButtonElement;
}

interface Editing {
  /** Null for a new notice. */
  item: Notice | null;
  opener: HTMLButtonElement;
}

/**
 * `/manage/notices` (P6-02c), for property management only (D1): the building's drafts, published and archived
 * notices, one list at a time (D3), with publish and archive. Keyed by building, so nothing of one building's lists or
 * an open dialog stays in another (criterion 8).
 */
export function ManagerNoticesPage() {
  const buildingId = useBuildingId();
  return <ManagerNotices key={buildingId} />;
}

function ManagerNotices() {
  // Under the page's guards, which render it only once the building has loaded.
  const building = useBuilding({ passive: true }).data;
  const time = buildingTime(building);
  const now = useNow();
  const [status, setStatus] = useState<ManagedStatus>('draft');
  const [open, setOpen] = useState<Open | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // As `WaitingList` (P5-03d): after a success the row leaves its list, so focus goes to the message; otherwise back
  // to the opener, or to the list's heading if a refresh took the opener's row. State, so the effect runs after the
  // commit that shows the message.
  const [focusTo, setFocusTo] = useState<{ target: HTMLElement | 'message' } | null>(null);
  useEffect(() => {
    if (focusTo) (focusTo.target === 'message' ? messageRef.current : focusTo.target)?.focus();
  }, [focusTo]);

  const close = (outcome: string | null) => {
    if (outcome) setMessage(outcome);
    const back = open?.opener.isConnected ? open.opener : headingRef.current;
    setFocusTo({ target: outcome || !back ? 'message' : back });
    setOpen(null);
  };
  const act = (action: NoticeAction, item: Notice, opener: HTMLButtonElement) => {
    setMessage(null);
    setOpen({ action, item, opener });
  };
  const edit = (item: Notice | null, opener: HTMLButtonElement) => {
    setMessage(null);
    setEditing({ item, opener });
  };
  const closeEditor = () => {
    const back = editing?.opener.isConnected ? editing.opener : headingRef.current;
    if (back) setFocusTo({ target: back });
    setEditing(null);
  };
  const list = LISTS.find((each) => each.status === status)!;

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Manage notices</h1>
        <button
          type="button"
          onClick={(event) => edit(null, event.currentTarget)}
          className="min-h-11 rounded bg-slate-900 px-4 text-sm font-medium text-white"
        >
          New notice
        </button>
      </div>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {LISTS.map((each) => (
          <button
            key={each.status}
            type="button"
            aria-pressed={each.status === status}
            onClick={() => {
              setMessage(null);
              setStatus(each.status);
            }}
            className={`min-h-11 rounded px-4 text-sm font-medium ${each.status === status ? 'bg-slate-900 text-white' : 'border'}`}
          >
            {each.label}
          </button>
        ))}
      </div>
      <p ref={messageRef} role="status" tabIndex={-1} data-testid={message ? 'notice-message' : undefined} className="text-sm font-medium empty:hidden [overflow-wrap:anywhere]">
        {message}
      </p>
      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
        {list.label}
      </h2>
      <ManagerNoticeList key={status} {...list} time={time} now={now} onAction={act} onEdit={edit} onFocusLost={() => headingRef.current?.focus()} />
      {open && <NoticeActionDialog action={open.action} item={open.item} onClose={close} />}
      {editing && building && (
        <NoticeEditor
          item={editing.item}
          timeZone={building.timezone}
          onSaved={(_, created) => created && setStatus('draft')}
          // P6-02c's confirm dialog takes over; focus goes back to the editor's opener after it (D3).
          onPublish={(item) => {
            setEditing(null);
            setOpen({ action: 'publish', item, opener: editing.opener });
          }}
          onClose={closeEditor}
        />
      )}
    </section>
  );
}
