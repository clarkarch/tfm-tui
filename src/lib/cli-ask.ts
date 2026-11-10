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
// of the BOOLEAN, not of the QUESTION, and a new command (or a new question)
// had to re-derive it.
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

// What a command does when there is no terminal to ask in. The VALUE is the
// policy; the command picks it, the helper applies it.
export type NonInteractivePolicy = "assume-yes" | "assume-no" | "abort";

// The prompt's default answer — the answer an EMPTY line takes. The update
// defaults to YES, the uninstall to NO; the two hand-written prompts used to
// differ only in that one letter.
export type AskDefault = "yes" | "no";

// The ask's outcome. "aborted" is NOT a NO answer: the command changed
// nothing at all (there was nobody to ask), which is a different thing to
// say to the user than "you said no".
export type AskOutcome = { kind: "answered"; value: boolean } | { kind: "aborted" };

export type AskOpts = {
  question: string;
  // the FACT: can we ask at all?
  interactive: boolean;
  // the POLICY: what to do when we cannot
  nonInteractive: NonInteractivePolicy;
  // the prompt's default answer (interactive only)
  defaultAnswer?: AskDefault;
  // the ask itself (interactive only) — injected by the tests
  ask?: (question: string) => Promise<boolean>;
};

// The ONE ask helper. It never asks when there is nobody to ask: the
// non-interactive policy decides, and the outcome says which branch ran.
export const askOnce = async (opts: AskOpts): Promise<AskOutcome> => {
  if (opts.interactive) {
    const ask = opts.ask ?? ((q: string) => promptYesNo(q, opts.defaultAnswer ?? "no"));
    return { kind: "answered", value: await ask(opts.question) };
  }
  switch (opts.nonInteractive) {
    case "assume-yes":
      return { kind: "answered", value: true };
    case "assume-no":
      return { kind: "answered", value: false };
    case "abort":
      return { kind: "aborted" };
    default: {
      const unhandled: never = opts.nonInteractive;
      throw new Error(`unhandled non-interactive policy: ${unhandled}`);
    }
  }
};

// The prompt's answer, as a PURE decision: an empty line takes the named
// default, anything else must say yes explicitly.
export const answerFromLine = (line: string, def: AskDefault): boolean => {
  const s = line.trim().toLowerCase();
  if (s === "") return def === "yes";
  return s === "y" || s === "yes";
};

// read one line from stdin (only reached under a tty). EOF reads as an empty
// line, so the prompt's DEFAULT answer wins — the user typed the command,
// and a lost terminal must not silently invert the default.
export const readTtyLine = async (): Promise<string> => {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!buf.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
  } catch {
    return "";
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return buf.split("\n")[0] ?? "";
};

// The interactive prompt: one implementation, the default answer named.
export const promptYesNo = async (question: string, def: AskDefault): Promise<boolean> => {
  process.stdout.write(`${question} [${def === "yes" ? "Y/n" : "y/N"}] `);
  return answerFromLine(await readTtyLine(), def);
};
