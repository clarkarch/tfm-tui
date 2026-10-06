// --- Executable detection for the default-open path: a +x file must run,
// not land in the browser/editor via xdg-open. Runnable content (ELF/AppImage
// binaries, #! scripts) counts even without the bit — that is the needsChmod
// case ("Make executable and run"). Pure except classifyPath's stat+sniff. ---

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type ExecutableInfo = { executable: boolean; needsChmod: boolean };

export const isElfHead = (head: Uint8Array): boolean =>
  head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;

export const isShebangHead = (head: Uint8Array): boolean => head.length >= 2 && head[0] === 0x23 && head[1] === 0x21;

export const isRunnableHead = (head: Uint8Array): boolean => isElfHead(head) || isShebangHead(head);

// pure core: mode bit wins; runnable content without the bit is needsChmod.
// Dirs are never executables here (opening a dir navigates, never runs).
export const classifyExecutable = (mode: number, isDir: boolean, head?: Uint8Array): ExecutableInfo => {
  if (isDir) return { executable: false, needsChmod: false };
  if ((mode & 0o111) !== 0) return { executable: true, needsChmod: false };
  if (head && isRunnableHead(head)) return { executable: true, needsChmod: true };
  return { executable: false, needsChmod: false };
};

const readHead = (p: string): Uint8Array | undefined => {
  try {
    const head = Buffer.alloc(4);
    const fd = openSync(p, "r");
    try {
      const n = readSync(fd, head, 0, 4, 0);
      return head.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

// sync path wrapper: stat first (no bit → sniff content, like the props
// checkbox did); anything unreadable/missing is not executable and falls
// through to the plain xdg-open path.
export const classifyPath = (p: string): ExecutableInfo => {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return { executable: false, needsChmod: false };
    if ((st.mode & 0o111) !== 0) return { executable: true, needsChmod: false };
    const head = readHead(p);
    if (head && isRunnableHead(head)) return { executable: true, needsChmod: true };
    return { executable: false, needsChmod: false };
  } catch {
    return { executable: false, needsChmod: false };
  }
};

// add exec where read exists (mirrors the props checkbox's set-bit loop) —
// the "Make executable and run" path must not clobber the file's perms with
// a flat 0o755.
export const addExecBits = (mode: number): number => {
  let nm = mode;
  for (const sh of [6, 3, 0]) {
    if ((mode >> sh) & 4) nm |= 1 << sh;
  }
  return nm;
};

// pick-overlay labels for the Run prompt (pure so menu + prompt stay in
// sync): a needsChmod file can't run as-is, so its rows say what they do.
export const executableChoiceLabels = (info: ExecutableInfo): [string, string, string] =>
  info.needsChmod
    ? ["Make executable and run", "Make executable and run in terminal", "Open anyway"]
    : ["Run", "Run in terminal", "Open anyway"];
