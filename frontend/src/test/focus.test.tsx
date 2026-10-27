// @vitest-environment jsdom
/**
 * WF-02 criteria 1–2: `activeElementLikeBrowser`, `expectFocusKept` and `expectFocusOn`, on throwaway components.
 * Each failing shape is the one the mistakes log shows reaching review (P6-02b R2 F1, P6-02c R1 F1 and R2 F1).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeElementLikeBrowser,
  expectFocusKept,
  expectFocusOn,
} from "@/test/focus";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = (name: string) =>
  screen.getByRole("button", { name, hidden: true });
/** An action that clicks `element` (fireEvent's boolean is not an action's result). */
const click = (element: Element) => () => {
  fireEvent.click(element);
};

describe("criterion 1: activeElementLikeBrowser", () => {
  it("a focused button that becomes disabled is <body>, though jsdom keeps it focused", () => {
    render(<button type="button">Save</button>);
    button("Save").focus();
    button("Save").setAttribute("disabled", "");
    expect(document.activeElement).toBe(button("Save"));
    expect(activeElementLikeBrowser()).toBe(document.body);
  });

  it("a focused button inside a fieldset that becomes disabled is <body>, except in its first legend", () => {
    render(
      <fieldset>
        <legend>
          <button type="button">In legend</button>
        </legend>
        <button type="button">In body</button>
      </fieldset>,
    );
    const fieldset = document.querySelector("fieldset")!;
    button("In body").focus();
    fieldset.disabled = true;
    expect(activeElementLikeBrowser()).toBe(document.body);
    fieldset.disabled = false;
    button("In legend").focus();
    fieldset.disabled = true;
    expect(activeElementLikeBrowser()).toBe(button("In legend"));
  });

  it("a link in a disabled fieldset stays focused: only form controls are disabled by it", () => {
    render(
      <fieldset disabled>
        <a href="#x">Help</a>
      </fieldset>,
    );
    screen.getByRole("link", { name: "Help" }).focus();
    expect(activeElementLikeBrowser()).toBe(
      screen.getByRole("link", { name: "Help" }),
    );
  });

  it("a focused element under a [hidden] ancestor, at any depth, is <body>", () => {
    render(
      <div data-testid="outer">
        <div>
          <button type="button">Deep</button>
        </div>
      </div>,
    );
    button("Deep").focus();
    screen.getByTestId("outer").hidden = true;
    expect(document.activeElement).toBe(button("Deep"));
    expect(activeElementLikeBrowser()).toBe(document.body);
  });

  it("a focused element inside an [inert] subtree is <body>", () => {
    render(
      <section data-testid="region">
        <button type="button">Inside</button>
      </section>,
    );
    button("Inside").focus();
    screen.getByTestId("region").setAttribute("inert", "");
    expect(activeElementLikeBrowser()).toBe(document.body);
  });

  it("a focused element under an [inert] ancestor, at any depth, is <body>", () => {
    render(
      <section data-testid="region">
        <div>
          <div>
            <button type="button">Deep</button>
          </div>
        </div>
      </section>,
    );
    button("Deep").focus();
    screen.getByTestId("region").setAttribute("inert", "");
    expect(document.activeElement).toBe(button("Deep"));
    expect(activeElementLikeBrowser()).toBe(document.body);
  });

  it("an enabled, attached element is itself; a removed one is already <body> in jsdom", () => {
    // A plain node, not React's: React's cleanup would fail on a node removed behind its back.
    const here = document.body.appendChild(
      Object.assign(document.createElement("button"), { textContent: "Here" }),
    );
    here.focus();
    expect(activeElementLikeBrowser()).toBe(here);
    here.remove();
    expect(document.activeElement).toBe(document.body);
    expect(activeElementLikeBrowser()).toBe(document.body);
  });
});

/** A dialog whose button disables itself; `handoff` moves focus to the dialog first, as `Modal` users do. */
function SelfDisabling({
  handoff,
}: {
  handoff: "dialog" | "none" | "blur" | "outside";
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const outside = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button ref={outside} type="button">
        Elsewhere
      </button>
      <div ref={dialog} role="dialog" aria-label="Edit" tabIndex={-1}>
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            if (handoff === "dialog") dialog.current?.focus();
            if (handoff === "blur") event.currentTarget.blur();
            if (handoff === "outside") outside.current?.focus();
            setBusy(true);
          }}
        >
          Save
        </button>
      </div>
    </>
  );
}

/** A row whose button moves focus to the next row's; a later refresh (`refreshed`) removes the rows. */
function RefreshedRows({ refreshed }: { refreshed: Promise<void> }) {
  const [rows, setRows] = useState(["a", "b"]);
  useEffect(() => void refreshed.then(() => setRows([])), [refreshed]);
  return (
    <div role="list" aria-label="Rows">
      {rows.map((row) => (
        <button
          key={row}
          type="button"
          onClick={() => document.getElementById("row-b")?.focus()}
          id={`row-${row}`}
        >
          Row {row}
        </button>
      ))}
    </div>
  );
}

/** A button removed two macrotasks after its click, with no handoff (a slow answer, no `settle`). */
function RemovedLater() {
  const [shown, setShown] = useState(true);
  return shown ? (
    <button
      type="button"
      onClick={() => setTimeout(() => setTimeout(() => setShown(false)))}
    >
      Done
    </button>
  ) : null;
}

const dialog = () => screen.getByRole("dialog", { name: "Edit" });

describe("criterion 2: expectFocusKept", () => {
  it("passes when the control disables itself and focus moves into the dialog first", async () => {
    render(<SelfDisabling handoff="dialog" />);
    button("Save").focus();
    await expectFocusKept(click(button("Save")), {
      control: () => button("Save"),
      within: dialog,
    });
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("fails with the message naming the control when it is left focused but disabled", async () => {
    render(<SelfDisabling handoff="none" />);
    button("Save").focus();
    await expect(
      expectFocusKept(click(button("Save")), {
        control: () => button("Save"),
        within: dialog,
      }),
    ).rejects.toThrow('focus fell to <body>; last focused: <button "Save">');
  });

  it("fails when focus goes to <body>", async () => {
    render(<SelfDisabling handoff="blur" />);
    button("Save").focus();
    await expect(
      expectFocusKept(click(button("Save")), { control: () => button("Save") }),
    ).rejects.toThrow('focus fell to <body>; last focused: <button "Save">');
  });

  it("fails when focus leaves `within` for an element outside it", async () => {
    render(<SelfDisabling handoff="outside" />);
    button("Save").focus();
    await expect(
      expectFocusKept(click(button("Save")), {
        control: () => button("Save"),
        within: dialog,
      }),
    ).rejects.toThrow('focus left <div "Edit">; on: <button "Elsewhere">');
  });

  it("fails when focus is fine after the action and a refresh that `settle` awaits drops it", async () => {
    let refresh!: () => void;
    const refreshed = new Promise<void>((resolve) => (refresh = resolve));
    render(<RefreshedRows refreshed={refreshed} />);
    button("Row a").focus();
    const list = () => screen.getByRole("list", { name: "Rows" });
    await expect(
      expectFocusKept(click(button("Row a")), {
        control: () => button("Row a"),
        within: list,
        settle: async () => {
          expect(document.activeElement).toBe(button("Row b"));
          refresh();
          await refreshed;
        },
      }),
    ).rejects.toThrow('focus fell to <body>; last focused: <button "Row b">');
  });

  it("keeps sampling after a first good sample: a control removed two macrotasks later fails", async () => {
    render(<RemovedLater />);
    button("Done").focus();
    await expect(
      expectFocusKept(click(button("Done")), { control: () => button("Done") }),
    ).rejects.toThrow('focus fell to <body>; last focused: <button "Done">');
  });

  it("fails before running the action when the test did not focus the control", async () => {
    render(<SelfDisabling handoff="dialog" />);
    const action = vi.fn();
    await expect(
      expectFocusKept(action, {
        control: () => button("Save"),
        within: dialog,
      }),
    ).rejects.toThrow(
      'before the action, focus must be on <button "Save">; it is on <body>',
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("fails before running the action when the focused control is outside `within`", async () => {
    render(<SelfDisabling handoff="dialog" />);
    button("Elsewhere").focus();
    const action = vi.fn();
    await expect(
      expectFocusKept(action, {
        control: () => button("Elsewhere"),
        within: dialog,
      }),
    ).rejects.toThrow('before the action, focus must be inside <div "Edit">');
    expect(action).not.toHaveBeenCalled();
  });

  it("an action's own error propagates unchanged", async () => {
    render(<SelfDisabling handoff="dialog" />);
    button("Save").focus();
    const error = new Error("the action failed");
    await expect(
      expectFocusKept(
        () => {
          throw error;
        },
        { control: () => button("Save") },
      ),
    ).rejects.toBe(error);
  });

  it("a `settle` that throws propagates its own error (review round 1, Codex's gap note)", async () => {
    render(<SelfDisabling handoff="dialog" />);
    button("Save").focus();
    const error = new Error("the refresh failed");
    await expect(
      expectFocusKept(click(button("Save")), {
        control: () => button("Save"),
        settle: () => Promise.reject(error),
      }),
    ).rejects.toBe(error);
  });

  it("refuses to run under fake timers, which would never let a macrotask turn pass", async () => {
    vi.useFakeTimers();
    render(<SelfDisabling handoff="dialog" />);
    button("Save").focus();
    await expect(
      expectFocusKept(click(button("Save")), { control: () => button("Save") }),
    ).rejects.toThrow("expectFocusKept needs real timers");
  });
});

describe("expectFocusOn", () => {
  it("passes when focus ends on the target", async () => {
    render(<SelfDisabling handoff="dialog" />);
    button("Save").focus();
    await expectFocusOn(click(button("Save")), dialog, {
      control: () => button("Save"),
    });
  });

  it("fails naming both when focus ends elsewhere", async () => {
    render(<SelfDisabling handoff="outside" />);
    button("Save").focus();
    await expect(
      expectFocusOn(click(button("Save")), dialog, {
        control: () => button("Save"),
      }),
    ).rejects.toThrow(
      'focus is on <button "Elsewhere">, expected <div "Edit">',
    );
  });

  it("fails when focus falls to <body>", async () => {
    render(<SelfDisabling handoff="none" />);
    button("Save").focus();
    await expect(
      expectFocusOn(click(button("Save")), dialog, {
        control: () => button("Save"),
      }),
    ).rejects.toThrow('focus fell to <body>; last focused: <button "Save">');
  });
});

it("the samples wait for state set inside act: no act() warning from the helper", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  render(<SelfDisabling handoff="dialog" />);
  button("Save").focus();
  await act(async () => {});
  await expectFocusKept(click(button("Save")), {
    control: () => button("Save"),
    within: dialog,
  });
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});
