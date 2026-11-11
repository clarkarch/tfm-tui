import { expect, test } from "bun:test";
import type { ListEntry } from "./menu-entry";

// A floating-list row's KIND is ONE tag, not parallel optional flags.
//
// The old shape spelled the kind as `sep?: boolean` + an optional
// `submenu`, with a REQUIRED `action` — so a row could be BOTH a separator
// and a flyout (illegal), and every separator carried a dummy
// `action: () => {}` that existed only because the kind was not tagged.
//
// The @ts-expect-error directives ARE the pin: an UNUSED directive is a
// typecheck error (TS2578), so the type must REJECT these shapes — the
// illegal combinations are unrepresentable, not merely discouraged.

test("a separator needs no action", () => {
  const sep: ListEntry = { kind: "sep" };
  expect(sep.kind).toBe("sep");
});

test("a separator cannot carry an action", () => {
  // @ts-expect-error a separator is a GAP: it has no action
  const sep: ListEntry = { kind: "sep", action: () => {} };
  expect(sep.kind).toBe("sep");
});

test("a separator cannot carry a submenu", () => {
  // @ts-expect-error a separator is a GAP: it has no flyout
  const sep: ListEntry = { kind: "sep", submenu: [] };
  expect(sep.kind).toBe("sep");
});

test("the old parallel flags are gone — the kind is the tag", () => {
  // @ts-expect-error `sep` is not a flag any more: the kind says it
  const sep: ListEntry = { kind: "sep", sep: true };
  expect(sep.kind).toBe("sep");
});
