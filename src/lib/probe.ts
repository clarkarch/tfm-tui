// --- A PROBE's answer: it ran, or it could not run.
//
// A probe asks a question the host may not be able to answer ("does this
// release exist?", "does anybody own this D-Bus name?"). The old shape
// carried the two failures of a boolean probe INSIDE the boolean:
//
//   true  = yes
//   false = no
//   null  = couldn't ask (offline, no busctl, no bus)
//
// `false` and `null` are BOTH falsy, so "no" and "unknown" were one
// `=== false` comparison away from being confused — and that comparison
// lived in ONE caller. A new caller that wrote `if (!exists)` turned
// "offline" into "there is no release v1.0.1" (and the installer then
// failed with a raw curl 404).
//
// The answer is now a RECORD with a discriminant:
//
//   { ok: true,  ...payload }  — the probe ran and the payload IS the truth
//   { ok: false, reason }      — the probe could not run, and says why
//
// "unknown" is never a payload value — it is the ABSENCE of one, so the
// type system makes a caller check the discriminant before it can read the
// payload. The two failure reasons are named: "offline" (the network did
// not answer) and "unavailable" (the host helper is missing).

export type ProbeFailure = "offline" | "unavailable";

export type Probe<T extends object> = ({ ok: true } & T) | { ok: false; reason: ProbeFailure };
