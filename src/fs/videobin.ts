// Locates the ffmpeg binary tfm uses for video thumbnails. Bundled-only by
// design: the shipped sidecar first, never the system PATH — distro ffmpeg
// is absent by default everywhere (Ubuntu universe, Fedora third-party,
// Arch extra) and varies wildly in version and startup cost.
import { accessSync, constants } from "node:fs";
import path from "node:path";

export const SIDECAR_NAME = "tfm-ffmpeg";

export type VideoBinSource = "override" | "sidecar" | "dev";
export type VideoBin = { bin: string; source: VideoBinSource };

export type VideoBinEnv = {
  override?: string | undefined; // $TFM_FFMPEG (test/ops seam, not a GUI knob)
  execDir?: string; // defaults to the running executable's directory
  devBin?: string | null; // require("ffmpeg-static") result, null when uninstalled
};

const isRunnable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Dynamic dev-only dep: missing/blocked postinstall is the normal null path.
const loadDevBin = (): string | null => {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: untyped CJS export (a path string)
    const mod: any = require("ffmpeg-static");
    return typeof mod === "string" ? mod : null;
  } catch {
    return null;
  }
};

export const resolveVideoBin = (env: VideoBinEnv = {}): VideoBin | null => {
  const { override = process.env.TFM_FFMPEG, execDir = path.dirname(process.execPath), devBin = loadDevBin() } = env;
  if (override && isRunnable(override)) return { bin: override, source: "override" };
  const sidecar = path.join(execDir, SIDECAR_NAME);
  if (isRunnable(sidecar)) return { bin: sidecar, source: "sidecar" };
  if (devBin && isRunnable(devBin)) return { bin: devBin, source: "dev" };
  return null;
};

// Memoized per process: neither the sidecar nor node_modules moves mid-run.
let cached: VideoBin | null | undefined;
export const videoBin = (): VideoBin | null => (cached ??= resolveVideoBin());
export const resetVideoBin = (): void => {
  cached = undefined;
};
