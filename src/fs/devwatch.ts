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
  // live lsblk device list (places.listMounts in prod; a fake array in tests).
  // null = the probe FAILED (unknown) — NOT "there are no devices": the
  // watcher keeps its baseline and retries on the next tick.
  devices: () => MountEntry[] | null | Promise<MountEntry[] | null>;
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

// The device set seen on the last SUCCESSFUL poll. `parts` fingerprints
// every block device (device + target, target empty when unmounted): the
// kernel creates /dev nodes with NO mountpoint on plug, so a target-only
// fingerprint sleeps through physical plug/unplug of unmounted drives.
// Arrivals stay keyed by whole disk (one toast per drive) and include
// unmounted partitions (their row is click-to-mount).
export type DeviceSnapshot = {
  readonly parts: Set<string>;
  readonly disks: Set<string>;
  readonly usb: Map<string, MountEntry[]>;
};

// ONE record for the watcher's lifecycle. The three facts used to live in
// three variables (stopped / inFlight / last) and every guard was their
// conjunction — a fourth fact would have silently broken it. The record
// names the states instead:
//   "idle"     — armed; the next tick polls. The baseline is the last
//                SUCCESSFUL device set (null until the first one lands).
//   "polling"  — a probe is in flight; it owns the device set, so a tick
//                that arrives meanwhile is skipped.
//   "stopped"  — dead: no tick polls, and a probe that lands afterwards
//                announces nothing (the stopped phase owns the landing).
// "stopped" and "polling" are mutually exclusive — the old shape could be
// dead AND probing at once, and the landing had to check both.
export type WatchState =
  | { readonly kind: "idle"; readonly baseline: DeviceSnapshot | null }
  | { readonly kind: "polling"; readonly baseline: DeviceSnapshot | null }
  | { readonly kind: "stopped"; readonly baseline: DeviceSnapshot | null };

export const makeDeviceWatcher = (ctx: DeviceWatcherCtx) => {
  const sched: Scheduler = ctx.sched ?? globalThis;
  const intervalMs = (): number =>
    Math.max(250, typeof ctx.intervalMs === "function" ? ctx.intervalMs() : (ctx.intervalMs ?? DEVICE_POLL_MS));
  let timer: unknown = null;
  let state: WatchState = { kind: "idle", baseline: null };

  const snapshot = (entries: MountEntry[]): DeviceSnapshot => {
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
    // only an IDLE watcher polls: a probe in flight owns the device set,
    // and a stopped watcher is dead
    if (state.kind !== "idle") return;
    const prior = state.baseline;
    state = { kind: "polling", baseline: prior };
    Promise.resolve()
      .then(() => ctx.devices())
      .then(
        (entries) => {
          // a stop during the probe WINS: the landing announces nothing
          if (state.kind === "stopped") return;
          // A FAILED probe (null) is UNKNOWN, not an empty device set: keep
          // the old baseline so the next tick retries instead of reading the
          // failure as an unplug-all (and then announcing every drive as new
          // on the next success). It is an expected state, not a crash.
          if (entries === null) {
            ctx.log?.("devwatch probe failed: keeping the last device set");
            state = { kind: "idle", baseline: prior };
            return;
          }
          const next = snapshot(entries);
          if (prior === null) {
            // baseline capture: boot-present drives stay silent
            state = { kind: "idle", baseline: next };
            return;
          }
          const arrived: MountEntry[] = [];
          for (const [disk, group] of next.usb) {
            if (!prior.disks.has(disk)) arrived.push(...group);
          }
          const changed =
            arrived.length > 0 ||
            next.parts.size !== prior.parts.size ||
            [...next.parts].some((p) => !prior.parts.has(p));
          state = { kind: "idle", baseline: next };
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
          if (state.kind === "stopped") return;
          ctx.log?.(`devwatch poll failed: ${err}`);
          state = { kind: "idle", baseline: prior };
        },
      );
  };

  const arm = (): void => {
    if (state.kind === "stopped") return;
    timer = sched.setTimeout(() => {
      timer = null;
      poll();
      arm();
    }, intervalMs());
  };
  arm();

  return {
    // the live record — a caller can ask where the watcher is without
    // reading its internals
    state: (): WatchState => state,
    stop: () => {
      state = { kind: "stopped", baseline: state.baseline };
      if (timer !== null) {
        try {
          sched.clearTimeout(timer);
        } catch {}
        timer = null;
      }
    },
  };
};
