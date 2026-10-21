import type { KeyboardEvent, ReactNode, RefObject } from 'react';

interface Props {
  labelledBy: string;
  /** While true, Escape doesn't close. */
  busy: boolean;
  onEscape: () => void;
  dialogRef: RefObject<HTMLDivElement>;
  children: ReactNode;
}

/**
 * The shell of the residents dialogs (P4-08b, P4-08c): a modal `role="dialog"` over a backdrop. Escape closes (not
 * while busy) and Tab stays inside; the dialog element itself is focusable, so a dialog can hold focus while its
 * buttons are disabled.
 */
export function Modal({ labelledBy, busy, onEscape, dialogRef, children }: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)') ?? []);
    const [first, last] = [focusable[0], focusable[focusable.length - 1]];
    if (!first) return event.preventDefault();
    // From the dialog itself or its alert (focused on purpose, not tabbable controls) too (P4-08b round 1, Codex F2).
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey ? index <= 0 : index === -1 || index === focusable.length - 1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-full w-full max-w-md overflow-y-auto rounded bg-white p-4 shadow-lg [overflow-wrap:anywhere]"
      >
        {children}
      </div>
    </div>
  );
}
