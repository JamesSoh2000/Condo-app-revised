import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function LoadingScreen() {
  return (
    <div role="status" className="fixed inset-0 flex items-center justify-center">
      <span className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-800" aria-hidden />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function FullPageMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 text-center">
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export function NotFoundPage() {
  return (
    <FullPageMessage title="Page not found">
      <p>There is no page at this address.</p>
      <Link to="/" className="mt-4 underline">
        Go to the home page
      </Link>
    </FullPageMessage>
  );
}

export function HomePlaceholder() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Home</h1>
      <p className="mt-2 text-slate-600">Your building’s home page is coming soon.</p>
    </section>
  );
}

/** A legacy page whose slice has not migrated it yet (P2-06a); the slice replaces this route. */
export function BeingMigrated({ page }: { page: string }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{page.replace(/([a-z])([A-Z])/g, '$1 $2')}</h1>
      <p className="mt-2 text-slate-600">This page is being migrated to the new app and will be back soon.</p>
    </section>
  );
}
