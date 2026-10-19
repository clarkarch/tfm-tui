// --- USB plug/unplug detection without restart: poll the lsblk device set
// and diff by block-device presence. Only genuinely NEW disks report
// (boot-present drives are the silent baseline — the first poll captures,
// never announces). Any add/remove/remount also fires onChange so the
// sidebar re-lists. Renderer-free: devices/onArrivals/onChange arrive via
// ctx, timing on an injected Scheduler (virtual clock in tests — bun has no
// fake timers). Poll cost is one lsblk (~34ms); renders stay change-gated
// so idle machines do no UI work. ---

import type { Scheduler } from "../lib/uiutil";
import type { MountEntry } from "./places";

type DeviceWatcherCtx = {
  // live lsblk device list (places.listMounts in prod; a fake array in tests)
  devices: () => MountEntry[] | Promise<MountEntry[]>;
  // newly arrived USB disks (one group per disk, all its partitions) — the
  // wiring toasts these; boot-present drives never arrive here
  onArrivals: (news: MountEntry[]) => void;
  // any device add/remove (including non-USB and unplugs) — the wiring
  // re-lists + re-renders; removals stay silent (the vanishing row is the
  // feedback, same as nautilus)
  onChange: () => void;
  // poll interval: a plain number in tests, a live config getter in prod so
  // a settings edit applies on the next tick with no restart and no rebuild
  // (the key is RENDER_EXEMPT for the same reason)
  intervalMs?: number | (() => number);
  sched?: Scheduler;
  log?: (msg: string) => void;
};

export const DEVICE_POLL_MS = 1000;

export const makeDeviceWatcher = (ctx: DeviceWatcherCtx) => {
  const sched: Scheduler = ctx.sched ?? globalThis;
  const intervalMs = (): number =>
    Math.max(250, typeof ctx.intervalMs === "function" ? ctx.intervalMs() : (ctx.intervalMs ?? DEVICE_POLL_MS));
  let timer: unknown = null;
  let stopped = false;
  let inFlight = false;
  // device presence + mount state seen on the last settled poll; null = no
  // baseline yet (the first poll captures silently, never announces).
  // `parts` fingerprints every block device (device + target, target empty
  // when unmounted): the kernel creates /dev nodes with NO mountpoint on
  // plug, so a target-only fingerprint sleeps through physical plug/unplug
  // of unmounted drives. Arrivals stay keyed by whole disk (one toast per
  // drive) and include unmounted partitions (their row is click-to-mount).
  let last: { parts: Set<string>; disks: Set<string>; usb: Map<string, MountEntry[]> } | null = null;

  const snapshot = (
    entries: MountEntry[],
  ): { parts: Set<string>; disks: Set<string>; usb: Map<string, MountEntry[]> } => {
    const parts = new Set<string>();
    const disks = new Set<string>();
    const usb = new Map<string, MountEntry[]>();
    for (const e of entries) {
      parts.add(`${e.device}${e.target}`);
      disks.add(e.disk);
      if (e.usb) {
        const group = usb.get(e.disk);
        if (group) group.push(e);
        else usb.set(e.disk, [e]);
      }
    }
    return { parts, disks, usb };
  };

  const poll = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(() => ctx.devices())
      .then(
        (entries) => {
          inFlight = false;
          if (stopped) return;
          const { parts, disks, usb } = snapshot(entries);
          if (last === null) {
            // baseline capture: boot-present drives stay silent
            last = { parts, disks, usb };
            return;
          }
          const prev = last;
          const arrived: MountEntry[] = [];
          for (const [disk, group] of usb) {
            if (!prev.disks.has(disk)) arrived.push(...group);
          }
          const changed =
            arrived.length > 0 || parts.size !== prev.parts.size || [...parts].some((p) => !prev.parts.has(p));
          last = { parts, disks, usb };
          if (arrived.length > 0) {
            try {
              ctx.onArrivals(arrived);
            } catch (err) {
              ctx.log?.(`devwatch arrivals failed: ${err}`);
            }
          }
          if (changed) {
            try {
              ctx.onChange();
            } catch (err) {
              ctx.log?.(`devwatch change failed: ${err}`);
            }
          }
        },
        (err) => {
          // a failed lsblk (wedged helper, missing binary) keeps the old
          // baseline: next tick retries instead of announcing every drive
          // as new (an error resolving to [] would look like an unplug-all
          // followed by a re-plug-all)
          inFlight = false;
          ctx.log?.(`devwatch poll failed: ${err}`);
        },
      );
  };

  const arm = (): void => {
    if (stopped) return;
    timer = sched.setTimeout(() => {
      timer = null;
      poll();
      arm();
    }, intervalMs());
  };
  arm();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        try {
          sched.clearTimeout(timer);
        } catch {}
        timer = null;
      }
    },
  };
};
