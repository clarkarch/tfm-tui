import { errMessage } from "../lib/uiutil";
import {
  probeDefaultFileManagerSync,
  recordFileManagerChoice,
  setDefaultFileManager,
  type FileManagerPromptAnswer,
} from "../fs/default-filemanager";

// --- `tfm default-filemanager <subcommand>`: headless default-handler
// management (no renderer). The scriptable twin of the first-boot prompt and
// the settings row — all three drive the same fs leaf, so behavior can't
// drift. Pure arg dispatch (parseDefaultFileManagerArgs) is separated from
// the xdg-mime side so dispatch is unit-testable. ---

export type DefaultFileManagerCommand = "status" | "set" | "unset" | "help";

export type DefaultFileManagerArgs = { cmd: DefaultFileManagerCommand; error: string | null };

// PURE: `tfm default-filemanager [status] | set | unset | help`
export const parseDefaultFileManagerArgs = (args: string[]): DefaultFileManagerArgs => {
  const bad = (error: string): DefaultFileManagerArgs => ({ cmd: "help", error });
  const first = args[0];
  if (first === undefined || first === "status") return { cmd: "status", error: null };
  if (first === "help" || first === "--help" || first === "-h") return { cmd: "help", error: null };
  if (first === "set") return { cmd: "set", error: null };
  if (first === "unset") return { cmd: "unset", error: null };
  return bad(`unknown default-filemanager subcommand: ${JSON.stringify(first)}`);
};

export const defaultFileManagerHelp = (): string =>
  `tfm default-filemanager — default file manager opt-in

Usage: tfm default-filemanager [status]
       tfm default-filemanager set
       tfm default-filemanager unset
       tfm default-filemanager help

  status            show the current default for folders (inode/directory)
                    (default when no subcommand is given)
  set               make tfm the default (remembers the replaced handler;
                    records "yes" only on success, so a failure re-asks)
  unset             restore the handler tfm replaced (refuses when none was
                    recorded — the default is never cleared blindly)

  exit codes: 0 ok · 1 operation failed · 2 unknown subcommand
`;

type DefaultFileManagerCliDeps = {
  out?: (line: string) => void;
  err?: (line: string) => void;
  currentDefault?: () => string;
  markerFile?: () => string;
  recordChoice?: (answer: FileManagerPromptAnswer) => void;
  setDefault?: (op: "set" | "unset") => Promise<{ ok: boolean; message: string }>;
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
        out(current ? `default file manager for folders: ${current}` : "default file manager for folders: unknown");
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
    }
  } catch (e) {
    err(`tfm: ${errMessage(e)}`);
    return 1;
  }
};
