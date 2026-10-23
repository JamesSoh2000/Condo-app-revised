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
 * The shell of the residents dialogs (P4-08b, P4-08c, P4-08e): a modal `role="dialog"` over a backdrop. Escape closes (not
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
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea, button:not(:disabled)') ?? []);
    // A radio group is one tab stop, as the browser tabs: its checked radio, else its first (P5-03d R2 F1).
    const stop = (element: HTMLElement): HTMLElement => {
      if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) return element;
      const group = controls.filter((other): other is HTMLInputElement => other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name);
      return group.find((radio) => radio.checked) ?? group[0];
    };
    const focusable = controls.filter((element) => stop(element) === element);
    const [first, last] = [focusable[0], focusable[focusable.length - 1]];
    if (!first) return event.preventDefault();
    // From the dialog itself or its alert (focused on purpose, not tabbable controls) too (P4-08b round 1, Codex F2).
    const active = document.activeElement;
    const index = active instanceof HTMLElement && controls.includes(active) ? focusable.indexOf(stop(active)) : -1;
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
