// --- Late-bound wiring seams.
//
// Some collaborators can only be built AFTER the consumer that captures
// them: the network impls need the notify sink, the sidebar hover impl
// needs the animator, the plugin API needs the keymap. Two shapes exist,
// and BOTH must announce an unavailable collaborator instead of pretending
// to work:
//
//   tdzSafe      — a READER whose getter can throw (a wiring const that is
//                  not initialized yet): the fallback is returned and the
//                  miss is logged.
//   makeLateSlot — a WRITER's impl that is assigned later: the slot is
//                  EXPLICITLY unset, and a call on an unset slot logs
//                  instead of silently doing nothing.
//
// The old chrome wiring initialized its late slots with NO-OP FUNCTIONS
// (`= async () => {}`), so "the impl is not assigned yet" and "the impl
// legitimately does nothing" were the SAME VALUE: a call that landed
// before the assignment silently did nothing — no toast, no log, no clue.
// A slot is ONE tagged record (unset | set), and the call path is the only
// way in.

import { dlog } from "../lib/log";
import { errMessage } from "../lib/uiutil";

// TDZ-safe late-cluster reader: getKeymap/getPick close over wirings that
// initialize AFTER the first plugin scan (an eager plugin calling
// api.commands()/ui.pick at activate top level would otherwise throw a
// ReferenceError and fail its own load). The fallback only ever surfaces
// pre-boot; lazy post-boot calls see the real values.
//
// The log is INJECTED (default: the always-on dlog) so the announcement is
// pinnable: an unavailable collaborator must SAY it fell back.
export const tdzSafe = <T>(get: () => T, fallback: T, log: (msg: string) => void = dlog): (() => T) => {
  return () => {
    try {
      return get();
    } catch (err) {
      // pre-boot eager calls legitimately hit this; a dlog keeps a REAL
      // wiring-order bug honest instead of a silent fallback forever
      try {
        log(`tdzSafe fallback: ${errMessage(err)}`);
      } catch {}
      return fallback;
    }
  };
};

// The slot's phase. "unset" is a NAMED state — not a null impl, not the
// identity of a no-op function.
export type LateSlotState<T> = { kind: "unset" } | { kind: "set"; impl: T };

export type LateSlot<T extends (...args: never[]) => unknown> = {
  /** the slot's name — it names the seam in the log line */
  readonly name: string;
  /** the slot's current phase (unset until the impl is assigned) */
  readonly state: () => LateSlotState<T>;
  /** bind the impl — the wiring assigns it once its dependency exists */
  assign: (impl: T) => void;
  /**
   * call the impl. An UNSET slot logs and returns undefined: the call is
   * reported, never silently absorbed. The impl's return value is passed
   * through so an async impl can still be awaited by its caller.
   */
  call: (...args: Parameters<T>) => ReturnType<T> | undefined;
};

export const makeLateSlot = <T extends (...args: never[]) => unknown>(
  name: string,
  log: (msg: string) => void,
): LateSlot<T> => {
  let impl: T | null = null;
  return {
    name,
    state: () => (impl === null ? { kind: "unset" } : { kind: "set", impl }),
    assign: (next: T) => {
      impl = next;
    },
    call: (...args: Parameters<T>) => {
      if (impl === null) {
        try {
          log(`late slot "${name}" called before assignment`);
        } catch {}
        return undefined;
      }
      return (impl as (...a: Parameters<T>) => ReturnType<T>)(...args);
    },
  };
};
