import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A page's `<h1>`, focused when it mounts, so a screen reader starts at the new screen's title and the
 * keyboard's next Tab is the screen's first control. A screen that replaces a form (an invalid link) gets it too.
 */
export function PageHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h1 ref={ref} tabIndex={-1} className="mb-6 text-2xl font-semibold outline-none">
      {children}
    </h1>
  );
}
