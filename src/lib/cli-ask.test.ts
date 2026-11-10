// --- The CLI's ask: ONE helper, ONE named policy.
//
// "Is this a TTY" was never just an output-format decision: the same boolean
// silently selected the DEFAULT ANSWER of each prompt, and whether a
// destructive question was reachable at all:
//
//   update:    interactive → ask ("Update now?", default YES)
//              piped      → install with NO question (assume yes)
//   uninstall: interactive → ask twice (default NO for both)
//              piped      → remove the PROGRAM with no question, keep the
//                          data (the data question is never asked)
//
// The two commands' policies were OPPOSITE (the update assumed yes, the
// uninstall's data wipe assumed no) and each was spelled as an
// `if (interactive)` branch at its call site — so the policy was a property
// of the BOOLEAN, not of the question, and a new command (or a new
// question) had to re-derive it.
//
// The policy is now a NAMED value, chosen at the ask site:
//
//   "assume-yes" → answer yes without asking (a non-destructive command the
//                    user explicitly invoked: `tfm update`)
//   "assume-no"  → answer no without asking (the data wipe is NEVER assumed)
//   "abort"      → change nothing and say why (a destructive removal needs
//                    a terminal to confirm in: `tfm uninstall` piped)
//
// Pure decisions only — the stdin/stdout plumbing lives beside them.

import { describe, expect, test } from "bun:test";
import { answerFromLine, askOnce } from "./cli-ask";

describe("the CLI ask's policy", () => {
  test("an interactive ask asks the question and returns the answer", async () => {
    const asked: string[] = [];
    const outcome = await askOnce({
      question: "Update now?",
      interactive: true,
      nonInteractive: "abort",
      ask: async (q) => {
        asked.push(q);
        return true;
      },
    });
    expect(asked).toEqual(["Update now?"]);
    expect(outcome).toEqual({ kind: "answered", value: true });
  });

  test("assume-yes answers yes WITHOUT asking", async () => {
    let asked = false;
    const outcome = await askOnce({
      question: "Update now?",
      interactive: false,
      nonInteractive: "assume-yes",
      ask: async () => {
        asked = true;
        return false;
      },
    });
    expect(asked).toBe(false);
    expect(outcome).toEqual({ kind: "answered", value: true });
  });

  test("assume-no answers no WITHOUT asking", async () => {
    let asked = false;
    const outcome = await askOnce({
      question: "Delete your settings, plugins and caches too?",
      interactive: false,
      nonInteractive: "assume-no",
      ask: async () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
    expect(outcome).toEqual({ kind: "answered", value: false });
  });

  test("abort changes NOTHING and never asks", async () => {
    let asked = false;
    const outcome = await askOnce({
      question: "Uninstall tfm?",
      interactive: false,
      nonInteractive: "abort",
      ask: async () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
    expect(outcome).toEqual({ kind: "aborted" });
  });
});

describe("the prompt's default answer", () => {
  test("an empty line takes the NAMED default", () => {
    // the update's prompt defaults to YES, the uninstall's to NO — two
    // hand-written copies of the same prompt used to differ only in that
    // one letter
    expect(answerFromLine("", "yes")).toBe(true);
    expect(answerFromLine("", "no")).toBe(false);
    expect(answerFromLine("   ", "no")).toBe(false);
  });

  test("an explicit answer always wins over the default", () => {
    expect(answerFromLine("y", "no")).toBe(true);
    expect(answerFromLine("yes", "no")).toBe(true);
    expect(answerFromLine("Y", "yes")).toBe(true);
    expect(answerFromLine("n", "yes")).toBe(false);
    expect(answerFromLine("no", "yes")).toBe(false);
    // anything else is a no (the safe answer for a destructive question)
    expect(answerFromLine("maybe", "yes")).toBe(false);
  });
});
