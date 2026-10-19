import { describe, expect, test } from "bun:test";
import { makeDeviceWatcher } from "./devwatch";
import type { MountEntry } from "./places";

// --- USB plug/unplug detection without restart: poll the lsblk device set,
// diff by whole-disk path, toast only genuinely NEW arrivals (boot-present
// drives are the silent baseline). Timing runs on an injected Scheduler so
// tests use a virtual clock (bun has no fake timers); the poll itself is
// async, so ticks settle via microtasks, never sleeps. ---

type Usb = { label: string; target: string; device: string; disk: string };

const entry = (u: Usb, extra?: Partial<MountEntry>): MountEntry => ({
  label: u.label,
  target: u.target,
  removable: true,
  usb: true,
  device: u.device,
  disk: u.disk,
  ...extra,
});

const STICK: Usb = { label: "stick", target: "/media/usb", device: "/dev/sdb1", disk: "/dev/sdb" };
const HDD1: Usb = { label: "hdd", target: "/media/hdd1", device: "/dev/sdc1", disk: "/dev/sdc" };
const HDD2: Usb = { label: "hdd", target: "/media/hdd2", device: "/dev/sdc2", disk: "/dev/sdc" };

// virtual clock: setTimeout stores the callback, step() runs pending ones
const makeClock = () => {
  let pending: Array<() => void> = [];
  const delays: number[] = [];
  return {
    sched: {
      setTimeout: (cb: () => void, ms: number) => {
        delays.push(ms);
        pending.push(cb);
        return pending.length;
      },
      clearTimeout: (_h: unknown) => {
        pending = [];
      },
    },
    step: async (n = 1) => {
      for (let i = 0; i < n; i++) {
        const run = pending;
        pending = [];
        for (const cb of run) cb();
        // let the async poll body settle before the next tick: the devices
        // promise chains several microtask hops (resolve + devices + handler)
        for (let j = 0; j < 10; j++) await Promise.resolve();
      }
    },
    pendingCount: () => pending.length,
    delays,
  };
};

const harness = (initial: MountEntry[]) => {
  let current = initial;
  const clock = makeClock();
  const arrivals: MountEntry[][] = [];
  let changes = 0;
  const w = makeDeviceWatcher({
    devices: () => current,
    onArrivals: (news: MountEntry[]) => arrivals.push(news),
    onChange: () => changes++,
    intervalMs: 2500,
    sched: clock.sched,
  });
  return {
    w,
    clock,
    arrivals,
    changes: () => changes,
    setDevices: (d: MountEntry[]) => {
      current = d;
    },
  };
};

describe("makeDeviceWatcher", () => {
  test("steady state across ticks fires nothing", async () => {
    const h = harness([entry(STICK)]);
    await h.clock.step(1); // baseline capture
    expect(h.changes()).toBe(0);
    await h.clock.step(5);
    expect(h.changes()).toBe(0);
    expect(h.arrivals).toEqual([]);
    h.w.stop();
  });

  test("a newly plugged drive toasts its arrival once", async () => {
    const h = harness([entry(STICK)]);
    await h.clock.step(1);
    h.setDevices([entry(STICK), entry(HDD1), entry(HDD2)]);
    await h.clock.step(1);
    expect(h.arrivals.length).toBe(1);
    // one disk = one arrival group, both partitions named
    expect(h.arrivals[0]!.map((e) => e.device).sort()).toEqual(["/dev/sdc1", "/dev/sdc2"]);
    expect(h.changes()).toBe(1);
    // settled: further ticks stay quiet
    await h.clock.step(2);
    expect(h.arrivals.length).toBe(1);
    expect(h.changes()).toBe(1);
    h.w.stop();
  });

  test("an unplugged drive fires change but no arrival", async () => {
    const h = harness([entry(STICK), entry(HDD1)]);
    await h.clock.step(1);
    h.setDevices([entry(STICK)]);
    await h.clock.step(1);
    expect(h.arrivals).toEqual([]);
    expect(h.changes()).toBe(1);
    h.w.stop();
  });

  test("a non-USB change refreshes silently (no arrival toast)", async () => {
    const internal = (target: string): MountEntry => ({
      label: "data",
      target,
      removable: false,
      usb: false,
      device: "/dev/sda1",
      disk: "/dev/sda",
    });
    const h = harness([entry(STICK), internal("/data")]);
    await h.clock.step(1);
    h.setDevices([entry(STICK), internal("/archive")]);
    await h.clock.step(1);
    expect(h.arrivals).toEqual([]);
    expect(h.changes()).toBe(1);
    h.w.stop();
  });

  test("an in-flight poll skips the next tick (no stacking)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let polls = 0;
    const clock = makeClock();
    let changes = 0;
    const w = makeDeviceWatcher({
      devices: () => {
        polls++;
        return gate.then(() => [entry(STICK)]);
      },
      onArrivals: () => {},
      onChange: () => changes++,
      intervalMs: 2500,
      sched: clock.sched,
    });
    await clock.step(1); // tick 1 parks on the gate
    expect(polls).toBe(1);
    await clock.step(1); // tick 2 must skip while tick 1 is in flight
    expect(polls).toBe(1);
    release();
    // tick 3 still sees the in-flight flag (the landing is observed after
    // tick time) — it skips too; tick 4 polls fresh once tick 1 has landed
    await clock.step(2);
    expect(polls).toBe(2);
    expect(changes).toBe(0);
    w.stop();
  });

  test("a live interval getter applies on the next tick (no restart)", async () => {
    // prod passes () => config.ui.devicePollMs so a settings edit takes
    // effect without rebuilding anything; the virtual clock records delays
    let ms = 2500;
    const clock = makeClock();
    const w = makeDeviceWatcher({
      devices: () => [entry(STICK)],
      onArrivals: () => {},
      onChange: () => {},
      intervalMs: () => ms,
      sched: clock.sched,
    });
    await clock.step(1);
    // construction arm + first re-arm both read the getter (2500)
    expect(clock.delays).toEqual([2500, 2500]);
    ms = 500;
    await clock.step(1);
    // the next re-arm picks up the edit — no restart, no rebuild
    expect(clock.delays.at(-1)).toBe(500);
    w.stop();
  });

  test("stop() silences future ticks", async () => {
    const h = harness([entry(STICK)]);
    await h.clock.step(1);
    h.w.stop();
    h.setDevices([entry(STICK), entry(HDD1)]);
    await h.clock.step(3);
    expect(h.arrivals).toEqual([]);
    expect(h.changes()).toBe(0);
    expect(h.clock.pendingCount()).toBe(0);
  });

  test("a physically plugged drive with no mountpoint still arrives", async () => {
    // the kernel creates /dev/sdb1 with NO target on plug (mount comes
    // later, if ever) — a target-only fingerprint sleeps through the plug
    const bare = { ...entry(STICK), target: "" };
    const h = harness([]);
    await h.clock.step(1);
    h.setDevices([bare]);
    await h.clock.step(1);
    expect(h.arrivals.length).toBe(1);
    expect(h.arrivals[0]!.map((e) => e.device)).toEqual(["/dev/sdb1"]);
    expect(h.changes()).toBe(1);
    h.w.stop();
  });

  test("unplugging an unmounted drive fires change but no arrival", async () => {
    const bare = { ...entry(STICK), target: "" };
    const h = harness([bare]);
    await h.clock.step(1);
    h.setDevices([]);
    await h.clock.step(1);
    expect(h.arrivals).toEqual([]);
    expect(h.changes()).toBe(1);
    h.w.stop();
  });

  test("mounting an already-present drive refreshes without re-toasting", async () => {
    // plug (bare) -> mount (target): the row must rebuild for the new
    // mountpoint, but the disk is not new so no second arrival toast
    const bare = { ...entry(STICK), target: "" };
    const h = harness([bare]);
    await h.clock.step(1);
    expect(h.arrivals.length).toBe(0);
    h.setDevices([entry(STICK)]);
    await h.clock.step(1);
    expect(h.arrivals).toEqual([]);
    expect(h.changes()).toBe(1);
    h.w.stop();
  });
});
