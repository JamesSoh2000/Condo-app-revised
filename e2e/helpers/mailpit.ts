import { expect, request } from '@playwright/test';

/** Mailpit's HTTP API on the host (both stacks publish it on 8025). */
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

export interface Email {
  id: string;
  subject: string;
  text: string;
}

interface SearchResult {
  messages: { ID: string; Subject: string; To: { Address: string }[] }[];
}

/**
 * The newest email to `to` whose subject includes `subjectIncludes`, polled until it arrives (the worker sends
 * mail a moment after the request that queued it). Each journey uses its own recipient, so the match is its own.
 */
export async function waitForEmail(to: string, subjectIncludes: string, timeout = 30_000): Promise<Email> {
  const api = await request.newContext({ baseURL: MAILPIT_URL });
  try {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          const response = await api.get('/api/v1/search', { params: { query: `to:"${to}"` } });
          expect(response.ok()).toBe(true);
          const { messages } = (await response.json()) as SearchResult;
          // Newest first; `to:` matches substrings, so the address is compared exactly.
          id = messages.find(
            (m) => m.To.some((r) => r.Address.toLowerCase() === to.toLowerCase()) && m.Subject.includes(subjectIncludes),
          )?.ID;
          return id;
        },
        { message: `email to ${to} with subject "${subjectIncludes}"`, timeout },
      )
      .toBeTruthy();
    const response = await api.get(`/api/v1/message/${id}`);
    expect(response.ok()).toBe(true);
    const message = (await response.json()) as { ID: string; Subject: string; Text: string };
    return { id: message.ID, subject: message.Subject, text: message.Text };
  } finally {
    await api.dispose();
  }
}

/** The first link in the email's text part whose path starts with `pathPrefix`, as a path (no origin). */
export function extractLink(email: Email, pathPrefix: string): string {
  for (const match of email.text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const url = new URL(match[0]);
    if (url.pathname.startsWith(pathPrefix)) return url.pathname + url.search;
  }
  throw new Error(`no ${pathPrefix} link in the email "${email.subject}"`);
}
