// @vitest-environment jsdom
/**
 * P6-02a criterion 3: a notice body is Markdown, never HTML (D1). Raw HTML shows as text, script never runs, and only
 * http(s), mailto and tel links keep an href.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoticeBody } from '@/features/notices/NoticeBody';

afterEach(cleanup);

const renderBody = (markdown: string) => render(<NoticeBody markdown={markdown} />).container;

describe('raw HTML is text, not elements', () => {
  it.each([
    ['a script tag', '<script>window.ran = true</script>', 'script'],
    ['an image with onerror', '<img src=x onerror="window.ran = true">', 'img'],
    ['a raw link', '<a href="https://evil.example">raw</a>', 'a'],
    ['an inline handler', 'Hello <span onmouseover="window.ran = true">there</span>', 'span'],
    ['an iframe', '<iframe src="https://evil.example"></iframe>', 'iframe'],
  ])('%s', (_, markdown, tag) => {
    const container = renderBody(markdown);
    expect(container.querySelector(tag)).toBeNull();
    expect(container.querySelector('[onerror], [onmouseover]')).toBeNull();
    // The author's text is kept, shown as written.
    expect(container.textContent).toContain(markdown.slice(0, 4));
    expect((window as { ran?: boolean }).ran).toBeUndefined();
  });
});

describe('links', () => {
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)', 'file:///etc/passwd'])(
    'a %s link keeps its text and has no href',
    (url) => {
      const container = renderBody(`[click me](${url})`);
      expect(container.textContent).toContain('click me');
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('[href]')).toBeNull();
    },
  );

  it.each(['https://example.com/path?q=1', 'http://example.com', 'mailto:office@example.com', 'tel:+15145550100'])(
    'a %s link opens in a new tab without the opener',
    (url) => {
      const link = renderBody(`[go](${url})`).querySelector('a')!;
      expect(link.getAttribute('href')).toBe(url);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    },
  );

  it('a relative link has no href (a notice links out, not into the app)', () => {
    expect(renderBody('[home](/logout)').querySelector('[href]')).toBeNull();
  });
});

describe('Markdown', () => {
  it('renders no image, from Markdown or a reference, but keeps its alt text', () => {
    const container = renderBody('![tracking pixel](https://t.example/x.png)\n\n![ref][1]\n\n[1]: https://t.example/y.png');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('tracking pixel');
  });

  it('renders headings, emphasis, lists, quotes and code', () => {
    const container = renderBody('# Water\n\n*soft* **loud**\n\n- one\n- two\n\n1. first\n\n> quoted\n\n`code`\n\n```\nblock\n```');
    expect(container.querySelector('h1, h2, h3, h4, h5, h6')?.textContent).toBe('Water');
    expect(container.querySelector('em')?.textContent).toBe('soft');
    expect(container.querySelector('strong')?.textContent).toBe('loud');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelector('ol li')?.textContent).toBe('first');
    expect(container.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.querySelector('pre')?.textContent).toContain('block');
  });

  it('a heading in a body never outranks the page and the card (h1, h2)', () => {
    const container = renderBody('# One\n\n## Two\n\n###### Six');
    expect(container.querySelector('h1, h2')).toBeNull();
  });

  it('logs no React warning for any payload', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderBody('<script>x</script> [a](javascript:x) ![i](https://t.example/i.png) # h');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
