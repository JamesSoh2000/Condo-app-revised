import Markdown, { type Components } from 'react-markdown';

/** The link schemes a notice may use; anything else (javascript:, data:, a path into the app) loses its href. */
const SAFE_URL = /^(https?:|mailto:|tel:)/i;

/** Keeps a URL only if its scheme is in `SAFE_URL`. */
function safeUrl(url: string): string | null {
  return SAFE_URL.test(url.trim()) ? url : null;
}

/**
 * A body's headings sit under the page's `h1` and the card's `h2` (P6-02a), so `#` is an `h3` and the rest follow,
 * down to `h6`. Links leave the app in a new tab, without the opener; one whose URL was dropped is its text alone. An
 * image is its alt text: no `<img>`, so no request.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => <h3 className="mt-3 text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-2 font-semibold">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-2 font-medium">{children}</h6>,
  h5: ({ children }) => <h6 className="mt-2 font-medium">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-2 font-medium">{children}</h6>,
  img: ({ alt }) => <>{alt}</>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
};

/**
 * A notice's body (P6-02a D1): Markdown only, never HTML. Without an HTML plugin `react-markdown` shows raw HTML as the
 * text it is, so nothing in a body becomes an element or runs; images are shown as their alt text (an outside image
 * is a request to another host; notice images are attachments, P6-02b), and links keep only the schemes above. The
 * feed and the editor's preview (P6-02d) both render through it.
 */
export function NoticeBody({ markdown }: { markdown: string }) {
  return (
    <div className="notice-body text-sm text-slate-800 [overflow-wrap:anywhere] [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown components={COMPONENTS} urlTransform={safeUrl}>
        {markdown}
      </Markdown>
    </div>
  );
}
