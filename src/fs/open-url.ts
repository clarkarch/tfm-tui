// --- External URL opener (About links): fire-and-forget xdg-open with a
// failure toast. Success stays silent (a toast per link click is noise).
// spawnSafe arms the async error listener a bare spawn misses (missing
// xdg-open would otherwise ride uncaughtException into exit(1)); the sync
// try/catch covers Bun-style throwers. No timeout: nothing waits on the
// child, so a wedged helper holds no queue. `spawn` is injectable for tests.
import { spawnSafe } from "./spawn-safe";
import type { NotifyLevel } from "../lib/notify-level";

export type UrlOpenerDeps = {
  spawn?: typeof spawnSafe;
  notify: (message: string, title?: string, level?: NotifyLevel) => void;
  log?: (message: string) => void;
};

export const makeUrlOpener = (deps: UrlOpenerDeps) => {
  const failToast = (url: string, err: unknown): void => {
    try {
      deps.notify(`Couldn't open ${url} — is xdg-open installed?`, "open", "error");
    } catch {}
    deps.log?.(`open-url failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const openUrl = (url: string): void => {
    try {
      const child = (deps.spawn ?? spawnSafe)("xdg-open", [url], { stdio: "ignore" }, (err) => failToast(url, err));
      try {
        child.unref?.();
      } catch {}
    } catch (err) {
      failToast(url, err);
    }
  };

  return { openUrl };
};
