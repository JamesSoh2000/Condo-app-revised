/**
 * Focus checks for jsdom tests (WF-02): a control that disables or removes itself, or whose row a refresh removes,
 * drops focus to <body> in a browser (the CLAUDE.md focus lesson; P6-02b R2 F1, P6-02c R1 F1 and R2 F1, P6-02f
 * R2 F1). jsdom doesn't, so a test that reads `document.activeElement` passes where Chromium fails. These read what a
 * browser would report, and keep sampling after the action, so a drop a little later still fails. CSS (`display:
 * none`, `visibility: hidden`) is not modelled: jsdom has no layout. Check those in Chromium (`e2e/helpers/focus.ts`).
 */
import { act } from "@testing-library/react";
import { vi } from "vitest";

type Action = () => void | Promise<void>;
type Find = () => Element | null;

/** Macrotask turns sampled after the action (and `settle`), so a drop one or two turns later is seen. */
const TURNS = 5;
// The elements a disabled <fieldset> disables (the HTML spec's "form-associated" listed elements that can be).
const FIELDSET_DISABLES = "button, input, select, textarea";

/** What a browser would report as focused. jsdom keeps a *disabled* element, one under a `[hidden]` ancestor and an
 *  `[inert]` one as `document.activeElement`; Chromium moves focus to <body>. (A removed element is already <body>.) */
export function activeElementLikeBrowser(): Element {
  const active = document.activeElement ?? document.body;
  if (active === document.body || !active.isConnected) return document.body;
  if (active.closest("[hidden], [inert]")) return document.body;
  if (
    active.matches(FIELDSET_DISABLES) &&
    (active.hasAttribute("disabled") || inDisabledFieldset(active))
  )
    return document.body;
  return active;
}

/** Inside a disabled <fieldset>, and not inside its first <legend> (which a disabled fieldset leaves enabled). */
function inDisabledFieldset(element: Element): boolean {
  for (
    let fieldset = element.parentElement?.closest("fieldset");
    fieldset;
    fieldset = fieldset.parentElement?.closest("fieldset")
  ) {
    if (!fieldset.hasAttribute("disabled")) continue;
    const legend = Array.from(fieldset.children).find(
      (child) => child.tagName === "LEGEND",
    );
    if (!legend?.contains(element)) return true;
  }
  return false;
}

/** The element focus must be on before `action`, and, after it, never leave. */
export async function expectFocusKept(
  action: Action,
  options: {
    control: Find; // required: the element the test has focused and the action acts on
    within?: Find; // focus must stay inside this (the dialog, the card)
    settle?: () => Promise<void>; // await the slow part (a refresh that removes the row) before sampling
  },
): Promise<void> {
  await sampleAfter("expectFocusKept", action, options);
}

/** The element that must have focus afterwards, when one specific element is meant. */
export async function expectFocusOn(
  action: Action,
  target: Find,
  options: { control: Find; settle?: () => Promise<void> },
): Promise<void> {
  const last = await sampleAfter("expectFocusOn", action, options);
  const expected = target();
  if (last !== expected)
    throw new Error(
      `focus is on ${describe(last)}, expected ${describe(expected)}`,
    );
}

/**
 * Checks focus is on `control` (inside `within`), runs `action`, then samples right after it, after `settle`, and at
 * each of `TURNS` macrotask turns; fails at the first sample on <body> or outside `within`. Returns the last sample.
 */
async function sampleAfter(
  name: string,
  action: Action,
  {
    control,
    within,
    settle,
  }: { control: Find; within?: Find; settle?: () => Promise<void> },
): Promise<Element> {
  if (vi.isFakeTimers())
    throw new Error(
      `${name} needs real timers: its samples wait for macrotask turns`,
    );
  const before = activeElementLikeBrowser();
  const expected = control();
  if (before !== expected)
    throw new Error(
      `before the action, focus must be on ${describe(expected)}; it is on ${describe(before)}`,
    );
  if (within && !within()?.contains(before))
    throw new Error(
      `before the action, focus must be inside ${describe(within())}`,
    );

  let lastFocused: Element = before;
  const sample = (): Element => {
    const now = activeElementLikeBrowser();
    if (now === document.body) {
      // jsdom still names a disabled or hidden element; a removed one is gone, so name the last one seen.
      const stale = document.activeElement;
      throw new Error(
        `focus fell to <body>; last focused: ${describe(stale && stale !== document.body ? stale : lastFocused)}`,
      );
    }
    const region = within?.();
    if (within && !region?.contains(now))
      throw new Error(
        `focus left ${describe(region ?? null)}; on: ${describe(now)}`,
      );
    lastFocused = now;
    return now;
  };

  await act(async () => {
    await action();
  });
  sample();
  if (settle) {
    // Not inside `act`: React holds updates until an `act` ends, so a `findBy…` or `waitFor` in it (which wrap
    // `act` themselves) would never see them.
    await settle();
    sample();
  }
  let last = lastFocused;
  for (let turn = 0; turn < TURNS; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    last = sample();
  }
  return last;
}

/** `<tag "accessible name">`, for failure messages: aria-label, else aria-labelledby, else the text. */
function describe(element: Element | null): string {
  if (element === null) return "<nothing>";
  if (element === document.body) return "<body>";
  const labelledBy = element
    .getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const name = (
    element.getAttribute("aria-label") ??
    labelledBy ??
    element.textContent ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim();
  return `<${element.tagName.toLowerCase()} "${name.slice(0, 60)}">`;
}
