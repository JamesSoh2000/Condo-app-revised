import { useVersion } from './useVersion';

/** In dev builds, a footer with the backend's version, proving the SPA → typed client → API wiring. */
export function DevVersionFooter() {
  // Statically false in a production build, so the footer and its request are left out of the bundle.
  return import.meta.env.DEV ? <VersionFooter /> : null;
}

function VersionFooter() {
  const { data, isError } = useVersion();
  if (!data && !isError) return null;
  return (
    <footer className="fixed bottom-1 right-2 z-50 text-[10px] text-slate-400 pointer-events-none">
      {data ? `API ${data.git_sha} (${data.environment})` : 'API unavailable'}
    </footer>
  );
}
