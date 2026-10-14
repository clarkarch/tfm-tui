import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errMessage } from "../lib/uiutil";
import type { NotifyLevel } from "../lib/notify-level";
import type { ExecFn } from "../plugins/plugin-install";

// --- "Make tfm the default file manager?" Yes/No/Ask-again opt-in. The
// user's answer lives in a marker file under $XDG_STATE_HOME/tfm/ (next to
// session.json) — never a config key, so config-schema.ts, the serializer,
// config.example.toml and the settings schema stay untouched. The xdg-mime
// spawn arrives as an ExecFn (same injectable seam as plugin-install) so
// tests fake it. Every fs touch is best-effort: a hostile path must never
// throw out of boot or a row action. ---

// the .desktop id install.sh registers (must match the installed filename)
export const TFM_DESKTOP_ID = "tfm.desktop";
export const DIRECTORY_MIME = "inode/directory";

export type FileManagerPromptAnswer = "yes" | "no" | "later";
export type FileManagerPromptVerdict = "ask" | "silent";

export const defaultFileManagerMarker = (): string =>
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "tfm", "default-file-manager");

// stashed previous default (the handler tfm replaced), so unset restores
// THAT instead of an invented fallback — a "restore" that guesses is a lie.
export const defaultFileManagerPrevFile = (): string =>
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "tfm", "default-file-manager.prev");

type ProbeDeps = {
  currentDefault?: () => string;
  markerFile?: () => string;
};

const readAnswer = (markerFile: () => string): FileManagerPromptAnswer | null => {
  try {
    const raw = readFileSync(markerFile(), "utf8").trim();
    if (raw === "yes" || raw === "no" || raw === "later") return raw;
    return null;
  } catch {
    return null;
  }
};

// raw recorded answer (null = never answered or garbage). The settings row
// needs yes-vs-no, which the two-state queryFileManagerChoice verdict erases
// (after an external switch-away, marker "yes" + current != tfm must read as
// undecided, not as "No").
export const readFileManagerAnswer = (deps: ProbeDeps = {}): FileManagerPromptAnswer | null =>
  readAnswer(deps.markerFile ?? defaultFileManagerMarker);

// shared orchestration behind the settings row, the first-boot prompt and
// the headless CLI: one object so the three surfaces can't drift. The live
// probe is read through on every call (never captured), so an out-of-band
// `xdg-mime default tfm.desktop` silences the prompt without a marker.
export type DefaultFileManagerOrchestration = {
  current(): string;
  choice(): "ask" | "silent";
  answer(): FileManagerPromptAnswer | null;
  set(op: "set" | "unset"): Promise<{ ok: boolean; message: string }>;
  record(answer: FileManagerPromptAnswer): void;
};

export const makeDefaultFileManagerOrchestration = (
  deps: ProbeDeps & {
    // forwarded to setDefaultFileManager (tests fake the spawn; prod uses
    // the real xdg-mime + entry scan)
    setDeps?: MimeDeps;
    // probe cache TTL in ms (tests use the default; the settings panel
    // rebuilds the model per hover step and each rebuild reads current()
    // twice — without this every hover spawns xdg-mime twice: the lag)
    cacheTtlMs?: number;
  } = {},
): DefaultFileManagerOrchestration => {
  const ttl = deps.cacheTtlMs ?? 2000;
  let cached = "";
  let cachedAt = 0;
  let hasCache = false;
  const liveProbe = (): string => {
    const now = Date.now();
    if (hasCache && now - cachedAt < ttl) return cached;
    let value = "";
    if (deps.currentDefault) {
      try {
        value = deps.currentDefault();
      } catch {
        value = "";
      }
    } else {
      try {
        value = probeDefaultFileManagerSync();
      } catch {
        value = "";
      }
    }
    cached = value;
    cachedAt = now;
    hasCache = true;
    return value;
  };
  const dropCache = (): void => {
    hasCache = false;
  };
  const marker = deps.markerFile ? { markerFile: deps.markerFile } : {};
  return {
    current: liveProbe,
    choice: () => queryFileManagerChoice({ currentDefault: liveProbe, ...marker }),
    answer: () => readFileManagerAnswer(marker),
    // a successful set/unset changes system state → the cache must drop or
    // the row keeps showing the pre-pick handler until the TTL. A failed op
    // changed nothing → keep the cache.
    set: async (op: "set" | "unset") => {
      const res = await setDefaultFileManager(op, deps.setDeps ?? {});
      if (res.ok) dropCache();
      return res;
    },
    record: (a) => recordFileManagerChoice(a, marker),
  };
};

// the first-boot (and on-demand) "make tfm the default file manager?"
// confirm, extracted so the verdict→open→record glue is unit-testable: the
// wiring supplies the confirm dialog + sinks, the leaf owns the mapping.
// Returns a promise of true when the question surfaced (confirm opened OR
// fallback toast), false when it stayed silent — a verdict of "ask" must
// NEVER end silent (that was the "no popup" bug class: swallowed throws
// with no trace). Dismissing the confirm (No/esc/click-away) records
// nothing — the dialog only fires onYes — so dismissal asks again by
// omission. There is deliberately no "later" write: the marker only ever
// says yes or no.
export type FileManagerConfirmItem = { message: string; yesLabel: string; onYes: () => void };

export type FileManagerPromptDeps = {
  choice(): FileManagerPromptVerdict;
  openConfirm(opts: FileManagerConfirmItem): void;
  setDefault(op: "set" | "unset"): Promise<{ ok: boolean; message: string }>;
  record(answer: FileManagerPromptAnswer): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  // sticky fallback when the confirm dialog is unavailable (TDZ at boot, a
  // throwing root). Absent = plain notify. Optional so old fakes work.
  notifySticky?(msg: string): void;
  log(msg: string): void;
  // installs the FileManager1 D-Bus activator after a successful Yes (the
  // Full combo: mime default + activator, so browsers reach tfm instead of
  // nautilus). Best-effort: a failure warns but never un-records the yes —
  // the mime half worked. Absent = mime only. Optional so old fakes work.
  installService?: () => Promise<{ ok: boolean; message: string }>;
  // fired when the yes-flow lands (success or failure) so the opener can
  // repaint. Optional so old fakes work.
  onSettled?: () => void;
};

export const PROMPT_TITLE = "Make tfm the default file manager?";

export const makeDefaultFileManagerPrompt = (
  deps: FileManagerPromptDeps,
): ((opts?: { force?: boolean }) => Promise<boolean>) => {
  return async (opts?: { force?: boolean }): Promise<boolean> => {
    // force bypasses the verdict gate: an explicit user gesture (flipping
    // the settings toggle) must ALWAYS surface the question, even when the
    // boot gate would stay shut on a settled answer. Boot never forces.
    let verdict: FileManagerPromptVerdict = "ask";
    if (!opts?.force) {
      try {
        verdict = deps.choice();
      } catch (err) {
        deps.log(`default-file-manager prompt skipped (verdict threw): ${errMessage(err)}`);
        return false;
      }
      if (verdict !== "ask") return false;
    }
    const onYes = (): void => {
      void (async () => {
        const settled = (): void => {
          try {
            deps.onSettled?.();
          } catch (err) {
            deps.log(`default-file-manager settled hook failed: ${errMessage(err)}`);
          }
        };
        let res: { ok: boolean; message: string };
        try {
          res = await deps.setDefault("set");
        } catch (err) {
          deps.log(`default-file-manager set failed: ${errMessage(err)}`);
          settled();
          return;
        }
        try {
          if (!res.ok) {
            deps.notify(res.message, "default file manager", "error");
            settled();
            return;
          }
          deps.record("yes");
          // Full combo second half: point browser "show in folder" at
          // tfm too. Best-effort — the mime half already landed.
          if (deps.installService) {
            try {
              const svc = await deps.installService();
              deps.notify(
                svc.ok ? res.message : `${res.message} · activator failed: ${svc.message}`,
                "default file manager",
                svc.ok ? "success" : "error",
              );
            } catch (err) {
              deps.log(`default-file-manager service install failed: ${errMessage(err)}`);
              deps.notify(res.message, "default file manager", "success");
            }
          } else {
            deps.notify(res.message, "default file manager", "success");
          }
        } catch (err) {
          deps.log(`default-file-manager answer failed: ${errMessage(err)}`);
        }
        settled();
      })().catch((err) => {
        deps.log(`default-file-manager set failed: ${errMessage(err)}`);
      });
    };
    try {
      deps.openConfirm({ message: PROMPT_TITLE, yesLabel: "Set as default", onYes });
      return true;
    } catch (err) {
      deps.log(`default-file-manager prompt failed to open: ${errMessage(err)}`);
      try {
        (deps.notifySticky ?? deps.notify)(
          "Make tfm the default file manager? — advanced → set as default file manager",
        );
      } catch (err2) {
        deps.log(`default-file-manager fallback toast failed: ${errMessage(err2)}`);
      }
      return true;
    }
  };
};

// should boot ask? A recorded "no" is final (silent). Anything else asks
// unless tfm is ACTUALLY the default right now — nothing to ask when the
// user already set it outside tfm. A stale "yes" (recorded yes, but some
// other handler is default now) re-asks: a yes on disk the user doesn't
// remember must never silence the prompt forever. A throwing probe asks:
// failed detection must not wedge boot into silence.
export const queryFileManagerChoice = (deps: ProbeDeps = {}): FileManagerPromptVerdict => {
  const markerFile = deps.markerFile ?? defaultFileManagerMarker;
  const answer = readAnswer(markerFile);
  if (answer === "no") return "silent";
  try {
    const current = deps.currentDefault?.() ?? "";
    if (current.trim() === TFM_DESKTOP_ID) return "silent";
  } catch {}
  return "ask";
};

export const recordFileManagerChoice = (answer: FileManagerPromptAnswer, deps: ProbeDeps = {}): void => {
  const markerFile = deps.markerFile ?? defaultFileManagerMarker;
  try {
    const file = markerFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${answer}\n`);
  } catch {}
};

// last handler tfm replaced ("" when unknown). Best-effort read.
export const defaultFileManagerPrev = (deps: { prevFile?: () => string } = {}): string => {
  try {
    return readFileSync((deps.prevFile ?? defaultFileManagerPrevFile)(), "utf8").trim();
  } catch {
    return "";
  }
};

const defaultExec: ExecFn = async (cmd, args) => {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exit, output: `${out}\n${err}`.trim() };
  } catch (err) {
    return { exit: 127, output: errMessage(err) };
  }
};

type MimeDeps = {
  exec?: ExecFn;
  currentDefault?: () => string;
  prevFile?: () => string;
  // entry-presence probe (tests fake it; default scans the applications
  // dirs). Set refuses when the entry is missing — pointing mimeapps.list at
  // a desktop file that isn't installed strands folder opens.
  entryInstalled?: () => boolean;
};

// a stashed handler becomes xdg-mime argv, so it must look like a desktop id
// (same class parseGitUrl guards: a dash-leading value parses as a flag).
// Array-argv kills shell injection; this kills option injection.
const isSafeDesktopId = (s: string): boolean =>
  s.length <= 255 && /^[A-Za-z0-9_@.+-]+\.desktop$/.test(s) && !s.startsWith("-");

// set = become the default (stash the replaced handler first so unset can
// restore it); unset = restore the stash, refusing when nothing was stashed
// (clearing the default entirely would strand folder opens). Never throws —
// failures arrive as {ok:false} for the toast/CLI to surface.
export const setDefaultFileManager = async (
  op: "set" | "unset",
  deps: MimeDeps = {},
): Promise<{ ok: boolean; message: string }> => {
  const exec = deps.exec ?? defaultExec;
  const fail = (message: string): { ok: boolean; message: string } => ({ ok: false, message });
  if (op === "set") {
    let prev = "";
    try {
      prev = (deps.currentDefault?.() ?? "").trim();
    } catch {}
    if (!(deps.entryInstalled?.() ?? isDesktopEntryInstalled())) {
      return fail("tfm.desktop isn't installed — reinstall tfm, then try again");
    }
    const res = await exec("xdg-mime", ["default", TFM_DESKTOP_ID, DIRECTORY_MIME]);
    if (res.exit !== 0)
      return fail(`Couldn't set tfm as the default file manager · ${res.output || `exit ${res.exit}`}`);
    // stash only a REAL replaced handler (not empty, not ourselves — a stale
    // empty stash would make a later unset refuse over nothing).
    if (prev && prev !== TFM_DESKTOP_ID) {
      try {
        const file = (deps.prevFile ?? defaultFileManagerPrevFile)();
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${prev}\n`);
      } catch {}
    }
    return { ok: true, message: "tfm is now the default file manager" };
  }
  const prev = defaultFileManagerPrev({ ...(deps.prevFile ? { prevFile: deps.prevFile } : {}) });
  if (!prev) return fail("No previous file manager recorded — the default is left unchanged");
  if (!isSafeDesktopId(prev))
    return fail("Recorded previous file manager looks unsafe — the default is left unchanged");
  const res = await exec("xdg-mime", ["default", prev, DIRECTORY_MIME]);
  if (res.exit !== 0) return fail(`Couldn't restore ${prev} · ${res.output || `exit ${res.exit}`}`);
  return { ok: true, message: `${prev} is the default file manager again` };
};

// sync probe for the boot gate + settings row (runOutShort-style: trimmed
// stdout, "" on failure — callers read "" as not-default). xdg-mime is fast
// (~10ms); a missing binary degrades to "" via the catch.
export const probeDefaultFileManagerSync = (): string => {
  try {
    const proc = Bun.spawnSync(["xdg-mime", "query", "default", DIRECTORY_MIME], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (proc.exitCode !== 0) return "";
    return proc.stdout.toString().trim();
  } catch {
    return "";
  }
};

// is the tfm desktop entry installed anywhere desktops look? XDG dirs first
// (user + system), $XDG_DATA_DIRS consulted live — no hardcoded-only list.
export const isDesktopEntryInstalled = (deps: { dataDirs?: () => string[] } = {}): boolean => {
  const probe = (p: string): boolean => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  };
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");
  const dataDirs = deps.dataDirs?.() ?? (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":");
  return (
    probe(path.join(dataHome, "applications", TFM_DESKTOP_ID)) ||
    dataDirs.some((d) => d && probe(path.join(d, "applications", TFM_DESKTOP_ID)))
  );
};
