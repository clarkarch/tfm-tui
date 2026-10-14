import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { errMessage } from "../lib/uiutil";
import {
  defaultFileManagerMarker,
  isDesktopEntryInstalled,
  probeDefaultFileManagerSync,
  readFileManagerAnswer,
  recordFileManagerChoice,
  setDefaultFileManager,
  TFM_DESKTOP_ID,
  type FileManagerPromptAnswer,
} from "../fs/default-filemanager";
import { fileManagerServiceEntry, fileManagerServiceFile } from "./filemanager-service";

// --- `tfm default-filemanager <subcommand>`: headless default-handler
// management (no renderer). The scriptable twin of the first-boot prompt and
// the settings row — all three drive the same fs leaf, so behavior can't
// drift. Pure arg dispatch (parseDefaultFileManagerArgs) is separated from
// the xdg-mime side so dispatch is unit-testable. ---

export type DefaultFileManagerCommand =
  | "status"
  | "set"
  | "unset"
  | "forget"
  | "service-install"
  | "service-remove"
  | "help";

export type DefaultFileManagerArgs = { cmd: DefaultFileManagerCommand; error: string | null };

// PURE: `tfm default-filemanager [status] | set | unset | forget | service-install | service-remove | help`
export const parseDefaultFileManagerArgs = (args: string[]): DefaultFileManagerArgs => {
  const bad = (error: string): DefaultFileManagerArgs => ({ cmd: "help", error });
  const first = args[0];
  if (first === undefined || first === "status") return { cmd: "status", error: null };
  if (first === "help" || first === "--help" || first === "-h") return { cmd: "help", error: null };
  if (first === "set") return { cmd: "set", error: null };
  if (first === "unset") return { cmd: "unset", error: null };
  if (first === "forget") return { cmd: "forget", error: null };
  if (first === "service-install") return { cmd: "service-install", error: null };
  if (first === "service-remove") return { cmd: "service-remove", error: null };
  return bad(`unknown default-filemanager subcommand: ${JSON.stringify(first)}`);
};

export const defaultFileManagerHelp = (): string =>
  `tfm default-filemanager — default file manager opt-in

Usage: tfm default-filemanager [status]
       tfm default-filemanager set
       tfm default-filemanager unset
       tfm default-filemanager forget
       tfm default-filemanager service-install
       tfm default-filemanager service-remove
       tfm default-filemanager help

  status            show the live handler, the recorded answer, and whether
                    the desktop entry is installed (default, no subcommand)
  set               make tfm the default (remembers the replaced handler;
                    records "yes" only on success, so a failure re-asks)
  unset             restore the handler tfm replaced (refuses when none was
                    recorded — the default is never cleared blindly)
  forget            delete the recorded answer so the prompt asks again
  service-install   register the FileManager1 D-Bus activator so browsers'
                    "show in folder" reaches tfm (fights nautilus for the
                    name — the running owner keeps it until it exits)
  service-remove    unregister the FileManager1 D-Bus activator

  exit codes: 0 ok · 1 operation failed · 2 unknown subcommand
`;

export const forgetFileManagerChoice = (deps: { markerFile?: () => string } = {}): boolean => {
  try {
    rmSync((deps.markerFile ?? defaultFileManagerMarker)(), { force: true });
    return true;
  } catch {
    return false;
  }
};

type DefaultFileManagerCliDeps = {
  out?: (line: string) => void;
  err?: (line: string) => void;
  currentDefault?: () => string;
  markerFile?: () => string;
  recordChoice?: (answer: FileManagerPromptAnswer) => void;
  setDefault?: (op: "set" | "unset") => Promise<{ ok: boolean; message: string }>;
  // status-truth seams (tests fake them; default reads the live machine)
  recordedAnswer?: () => FileManagerPromptAnswer | null;
  entryInstalled?: () => boolean;
  forgetChoice?: () => boolean;
  // service-file seams (tests fake them; default touches the user bus dir)
  serviceFile?: () => string;
  serviceExec?: () => string;
  writeService?: (file: string, content: string) => void;
  removeService?: (file: string) => void;
};

// binary path for the service activator: the installed tfm on PATH wins
// (dev runs would otherwise point the bus at the bun interpreter)
const defaultServiceExec = (): string => {
  try {
    return Bun.which("tfm") ?? process.execPath;
  } catch {
    return process.execPath;
  }
};

export const runDefaultFileManagerCli = async (
  args: string[],
  deps: DefaultFileManagerCliDeps = {},
): Promise<number> => {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const currentDefault = deps.currentDefault ?? probeDefaultFileManagerSync;
  const parsed = parseDefaultFileManagerArgs(args);
  if (parsed.error) {
    err(`tfm: ${parsed.error}`);
    err("try 'tfm default-filemanager help'");
    return 2;
  }
  try {
    switch (parsed.cmd) {
      case "help":
        out(defaultFileManagerHelp());
        return 0;
      case "status": {
        let current = "";
        try {
          current = currentDefault();
        } catch {}
        const marker = deps.markerFile ? { markerFile: deps.markerFile } : {};
        let answer: FileManagerPromptAnswer | null = null;
        try {
          answer = deps.recordedAnswer?.() ?? readFileManagerAnswer(marker);
        } catch {}
        let entry = false;
        try {
          entry = deps.entryInstalled?.() ?? isDesktopEntryInstalled();
        } catch {}
        out(current ? `default file manager for folders: ${current}` : "default file manager for folders: unknown");
        out(`recorded answer: ${answer ?? "(none — the prompt will ask)"}`);
        out(entry ? "desktop entry: installed" : "desktop entry: MISSING (reinstall tfm)");
        // the stale-yes callout: recorded yes while the system uses another
        // handler is exactly the "have no idea it's not set" state
        if (answer === "yes" && current && current !== TFM_DESKTOP_ID) {
          out(`note: recorded "yes" is not in effect — run 'tfm default-filemanager set' or pick Yes again`);
        }
        return 0;
      }
      case "set": {
        // record yes ONLY on success: a failed yes must re-ask (prompt, next boot)
        const res = await (deps.setDefault?.("set") ?? setDefaultFileManager("set"));
        if (!res.ok) {
          err(`tfm: ${res.message}`);
          return 1;
        }
        (deps.recordChoice ?? recordFileManagerChoice)("yes", {
          ...(deps.markerFile ? { markerFile: deps.markerFile } : {}),
        });
        out(res.message);
        return 0;
      }
      case "unset": {
        const res = await (deps.setDefault?.("unset") ?? setDefaultFileManager("unset"));
        if (!res.ok) {
          err(`tfm: ${res.message}`);
          return 1;
        }
        (deps.recordChoice ?? recordFileManagerChoice)("no", {
          ...(deps.markerFile ? { markerFile: deps.markerFile } : {}),
        });
        out(res.message);
        return 0;
      }
      case "forget": {
        const ok =
          deps.forgetChoice?.() ??
          forgetFileManagerChoice({ ...(deps.markerFile ? { markerFile: deps.markerFile } : {}) });
        if (!ok) {
          err("tfm: couldn't delete the recorded answer");
          return 1;
        }
        out("recorded answer forgotten — the prompt will ask again");
        return 0;
      }
      case "service-install": {
        const file = deps.serviceFile?.() ?? fileManagerServiceFile();
        const exec = deps.serviceExec?.() ?? defaultServiceExec();
        try {
          if (deps.writeService) deps.writeService(file, fileManagerServiceEntry(exec));
          else {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, fileManagerServiceEntry(exec));
          }
        } catch (e) {
          err(`tfm: couldn't write ${file}: ${errMessage(e)}`);
          return 1;
        }
        out(`FileManager1 service installed — browsers' "show in folder" now activates ${exec}`);
        out("note: a running owner (nautilus) keeps the name until it exits");
        return 0;
      }
      case "service-remove": {
        const file = deps.serviceFile?.() ?? fileManagerServiceFile();
        try {
          if (deps.removeService) deps.removeService(file);
          else rmSync(file, { force: true });
        } catch (e) {
          err(`tfm: couldn't remove ${file}: ${errMessage(e)}`);
          return 1;
        }
        out("FileManager1 service removed");
        return 0;
      }
    }
  } catch (e) {
    err(`tfm: ${errMessage(e)}`);
    return 1;
  }
};
