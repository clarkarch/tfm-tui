// --- The ONE PATH probe. Bun.which caches PATH per process, so the bare call
// resolves against whatever PATH was at first use — a dir added to PATH after
// that (or a runtime-prepended stub dir) is invisible. Passing PATH
// explicitly makes every probe honest.
//
// This is the same staleness class as Bun.spawn's PATH (exec-bun.ts and
// spawn-safe.ts already copy process.env for it) and it was already fixed
// once, in videobin.ts, without being propagated. This leaf is the single
// owner so the next tool probe cannot drift back to the stale bare call;
// which.test.ts fails the build if a bare `Bun.which(` reappears in src/.
//
// Callers that need a different probe (tests, the archive `which` seam) keep
// injecting their own — this is the PRODUCTION default, not a replacement for
// the seam.

export const whichLive = (cmd: string): string | null => Bun.which(cmd, { PATH: process.env.PATH ?? "" });
