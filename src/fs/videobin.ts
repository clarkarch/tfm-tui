// Locates the ffmpeg binary tfm uses for video thumbnails: the $TFM_FFMPEG
// override (ops/test seam), else `ffmpeg` on PATH. Deliberately NOT bundled —
// shipping/downloading a ~80MB static sidecar to duplicate a package every
// distro carries was bad value: install.sh names ffmpeg in its missing-tools
// hint and a machine without it simply keeps plain video icons
// (canThumbVideo gates every call site).
import { accessSync, constants } from "node:fs";
import { whichLive } from "./which";

export type VideoBinSource = "override" | "path";
export type VideoBin = { bin: string; source: VideoBinSource };

export type VideoBinEnv = {
  override?: string | undefined; // $TFM_FFMPEG (test/ops seam, not a GUI knob)
  which?: (cmd: string) => string | null; // PATH probe (tests inject)
};

const isRunnable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// The PATH probe must see the LIVE environment: Bun.which caches PATH per
// process, so the bare call resolves against whatever PATH was at first use
// — a runtime-prepended dir is ignored (probed 1.4.0, the same staleness
// class AGENTS records for Bun.spawn). fs/which.ts is the single owner.
export const resolveVideoBin = (env: VideoBinEnv = {}): VideoBin | null => {
  const { override = process.env.TFM_FFMPEG, which = whichLive } = env;
  if (override && isRunnable(override)) return { bin: override, source: "override" };
  const onPath = which("ffmpeg");
  if (onPath) return { bin: onPath, source: "path" };
  return null;
};

// Memoized per process: the disk scan behind Bun.which runs on every video
// tile otherwise. A dead binary mid-run is recovered by resetVideoBin
// (renderVideoPng drops the memo on a spawn-level failure).
let cached: VideoBin | null | undefined;
export const videoBin = (): VideoBin | null => (cached ??= resolveVideoBin());
export const resetVideoBin = (): void => {
  cached = undefined;
};
