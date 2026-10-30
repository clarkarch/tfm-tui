import os from "node:os";
import path from "node:path";
import { errMessage } from "../lib/uiutil";
import { planShowFolders, planShowItems, type ShowPlan } from "../dnd/filemanager1";
import { whichLive } from "../fs/which";

// --- `tfm --filemanager-service`: D-Bus org.freedesktop.FileManager1 daemon.
// Browsers/apps call ShowItems ("show in folder") over D-Bus FIRST and only
// fall back to xdg-open when nobody answers — so the mimeapps default alone
// never redirects Firefox/Chrome while Nautilus owns the name. This daemon
// owns the name and opens one tfm per plan through the installed desktop
// entry (gio launch honors Terminal=true, no terminal guessing).
// The bus + opener arrive via deps so tests fake them (no session bus).
// ShowItemProperties degrades to highlight (no properties-at-boot support).
// Exit codes: 0 owned, 2 name taken/failure (honest stderr, never silent). ---

export const SERVICE_NAME = "org.freedesktop.FileManager1";
export const SERVICE_PATH = "/org/freedesktop/FileManager1";

type BusLike = {
  export(path: string, iface: unknown): void;
  requestName(name: string, flags: unknown): Promise<number>;
  // dbus-next MessageBus is an EventEmitter ('disconnect'/'error'/'message'
  // end or inform the session). Optional so old fakes keep working; prod
  // wires them to onExit.
  on?(event: string, cb: (msg?: unknown) => void): void;
  disconnect?(): void;
};

type ServiceDeps = {
  bus: BusLike;
  openPlan(plan: ShowPlan): void;
  log(msg: string): void;
  // builds the exported interface object (lazy dbus-next import — prod only;
  // tests inject a stub so start() never touches the real bus modules)
  buildInterface?: () => Promise<unknown>;
  // called when the bus session ends (disconnect/error). Prod exits non-zero
  // so the NEXT activation restarts a fresh daemon — a disconnected daemon
  // that lingers would hold a dead name and silently eat every ShowItems.
  // Optional so old fakes keep working.
  onExit?(code: number): void;
};

// the real dbus-next interface object (lazy import: the main TUI graph never
// loads dbus). Only called by runFileManagerService, never by tests (they
// drive showItems/showFolders directly or stub buildInterface).
export const buildFileManagerInterface = async (calls: {
  showItems(uris: string[], startupId: string): void;
  showFolders(uris: string[], startupId: string): void;
  showItemProperties(uris: string[], startupId: string): void;
}): Promise<unknown> => {
  const dbus = await import("dbus-next");
  class FM extends (dbus as unknown as { interface: { Interface: new (name: string) => object } }).interface.Interface {
    ShowItems(uris: string[], startupId: string): void {
      calls.showItems(uris, startupId);
    }
    ShowFolders(uris: string[], startupId: string): void {
      calls.showFolders(uris, startupId);
    }
    ShowItemProperties(uris: string[], startupId: string): void {
      calls.showItemProperties(uris, startupId);
    }
  }
  (FM as unknown as { configureMembers(spec: unknown): void }).configureMembers({
    methods: {
      ShowItems: { inSignature: "ass", outSignature: "" },
      ShowFolders: { inSignature: "ass", outSignature: "" },
      ShowItemProperties: { inSignature: "ass", outSignature: "" },
    },
  });
  return new FM(SERVICE_NAME);
};

// dbus-next primary-owner result (1 = became owner; 2/3/4 = exists/queued/...)
const PRIMARY_OWNER = 1;

export const makeFileManagerService = (deps: ServiceDeps) => {
  // a dead session must never linger: exit so the next ShowItems ACTIVATES a
  // fresh daemon instead of landing on a name nobody answers (the "only the
  // first open works" bug class). Exit once — error+disconnect often arrive
  // together and a double exit races the teardown.
  let exited = false;
  const exitOnce = (why: string): void => {
    if (exited) return;
    exited = true;
    deps.log(`${why} — exiting so activation restarts a fresh daemon`);
    try {
      deps.onExit?.(2);
    } catch {}
  };
  try {
    deps.bus.on?.("disconnect", () => exitOnce("bus disconnected"));
    deps.bus.on?.("error", () => exitOnce("bus error"));
    // NameLost for OUR name (nautilus re-took it): a daemon without the name
    // answers nothing — exit so the next ShowItems activates whoever is
    // configured instead of landing on a dead holder. Other names' signals
    // are none of our business. dbus-next MessageType.SIGNAL = 4.
    deps.bus.on?.("message", (msg) => {
      try {
        const m = msg as { type?: unknown; member?: unknown; body?: unknown };
        if (m?.type === 4 && m?.member === "NameLost" && Array.isArray(m?.body) && m.body[0] === SERVICE_NAME) {
          exitOnce(`lost the name ${SERVICE_NAME}`);
        }
      } catch {}
    });
  } catch {}
  const route = (plans: ShowPlan[], method: string): void => {
    if (!plans.length) {
      deps.log(`${method}: no local plans, nothing opened`);
      return;
    }
    for (const plan of plans) {
      try {
        deps.openPlan(plan);
      } catch (err) {
        deps.log(`open ${plan.dir} failed: ${errMessage(err)}`);
      }
    }
  };

  const showItems = (uris: string[], _startupId: string): void => route(planShowItems(uris), "ShowItems");
  const showFolders = (uris: string[], _startupId: string): void => route(planShowFolders(uris), "ShowFolders");
  const showItemProperties = (uris: string[], startupId: string): void => {
    deps.log("ShowItemProperties degrades to highlight (no properties view)");
    showItems(uris, startupId);
  };

  // wires the interface object onto a REAL dbus-next bus (lazy import: the
  // main TUI graph never loads dbus). Only called by runFileManagerService,
  // never by tests (they drive showItems/showFolders directly).
  const attach = async (bus: { export(path: string, iface: unknown): void }): Promise<void> => {
    bus.export(
      SERVICE_PATH,
      await (deps.buildInterface?.() ?? buildFileManagerInterface({ showItems, showFolders, showItemProperties })),
    );
  };

  const start = async (): Promise<number> => {
    try {
      await attach(deps.bus);
    } catch (err) {
      deps.log(`export failed: ${errMessage(err)}`);
      return 2;
    }
    let result = 0;
    try {
      // REPLACE_EXISTING (2) | DO_NOT_QUEUE (4): take the name off a stale
      // holder instead of queueing behind it — DO_NOT_QUEUE alone leaves
      // nautilus holding the name and BOTH file managers open side by side.
      // A running nautilus that disallows replacement still wins (result 3);
      // NameLost later exits us the moment it re-takes it.
      result = await deps.bus.requestName(SERVICE_NAME, 2 | 4);
    } catch (err) {
      deps.log(`requestName failed: ${errMessage(err)}`);
      return 2;
    }
    if (result !== PRIMARY_OWNER) {
      deps.log(
        `${SERVICE_NAME} already owned (nautilus holds it?) — quit the owner or remove its service file, then retry`,
      );
      return 2;
    }
    return 0;
  };

  return { showItems, showFolders, showItemProperties, start };
};

// production opener: one tfm per plan through the installed desktop entry.
// `tfm <file>` chdirs to the parent + pendingSelect highlights it, so the
// select side rides the existing launch path for free. gio's async errors
// arrive via callback (fire-and-forget spawn never throws sync).
export const openPlanWithEntry = (
  plan: ShowPlan,
  launch: (desktopFile: string, uri: string, onFail?: (e: Error) => void) => void,
  entryPath: (id: string) => string | null,
  log: (msg: string) => void,
): void => {
  const entry = entryPath("tfm.desktop");
  if (!entry) {
    log("tfm.desktop not installed — run the installer first");
    return;
  }
  const target = plan.select ?? plan.dir;
  launch(entry, target, (e) => log(`open ${target} failed: ${errMessage(e)}`));
};

// service-file management (user bus, opt-in): install writes the activator
// pointing at THIS binary; remove deletes it. The bus picks new service
// files up on the next activation — no daemon reload needed.
export const fileManagerServiceFile = (
  dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"),
): string => path.join(dataHome, "dbus-1", "services", `${SERVICE_NAME}.service`);

export const fileManagerServiceEntry = (execPath: string): string =>
  `[D-BUS Service]\nName=${SERVICE_NAME}\nExec=${execPath} --filemanager-service\n`;

// binary path for the service activator: the installed tfm on PATH wins
// (dev runs would otherwise point the bus at the bun interpreter)
export const resolveServiceExec = (): string => {
  try {
    return whichLive("tfm") ?? process.execPath;
  } catch {
    return process.execPath;
  }
};

// is the well-known name currently owned (by anyone)? Best-effort busctl
// probe for `status` (null = unknown: no busctl, no bus). Short timeout —
// a wedged busctl must never hang the CLI.
export const probeNameOwned = async (): Promise<boolean | null> => {
  try {
    const proc = Bun.spawn(
      [
        "busctl",
        "--user",
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "NameHasOwner",
        "s",
        SERVICE_NAME,
      ],
      {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        timeout: 3000,
        // the live PATH — Bun.spawn resolves the binary against the PATH it
        // cached at process start unless the env is passed fresh (same class
        // as Bun.which: src/fs/which.ts passes { PATH } for this reason)
        env: { ...process.env },
      },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (/\bb\s+true\b/.test(out)) return true;
    if (/\bb\s+false\b/.test(out)) return false;
    return null;
  } catch {
    return null;
  }
};

// writes the user-bus activator for the given binary (the Full combo's
// second half: Yes = mime default + activator). Injectable fs so tests never
// touch the bus dir; failures arrive as {ok:false}, never throws.
export const installFileManagerService = async (
  execPath: string,
  deps: { serviceFile?: () => string; write?: (file: string, content: string) => void } = {},
): Promise<{ ok: boolean; message: string }> => {
  const file = deps.serviceFile?.() ?? fileManagerServiceFile();
  try {
    if (deps.write) deps.write(file, fileManagerServiceEntry(execPath));
    else {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, fileManagerServiceEntry(execPath));
    }
    return { ok: true, message: `FileManager1 activator installed (${file})` };
  } catch (err) {
    return { ok: false, message: `Couldn't install the FileManager1 activator · ${errMessage(err)}` };
  }
};

// process entry: real session bus + real opener, run until killed (D-Bus
// activation restarts us on demand via the service file). Never returns 0
// while the bus is alive — the process IS the service.
export const runFileManagerService = async (
  deps: { out?: (line: string) => void; err?: (line: string) => void } = {},
): Promise<number> => {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const log = (m: string): void => {
    try {
      err(`tfm filemanager-service: ${m}`);
    } catch {}
  };
  let bus: { sessionBus(): BusLike };
  try {
    bus = (await import("dbus-next")) as unknown as { sessionBus(): BusLike };
  } catch (e) {
    err(`tfm: D-Bus unavailable: ${errMessage(e)}`);
    return 2;
  }
  const { launchApp, desktopFilePath } = await import("../fs/apps");
  const sessionBus = bus.sessionBus();
  const svc = makeFileManagerService({
    bus: sessionBus,
    openPlan: (plan) => openPlanWithEntry(plan, launchApp, desktopFilePath, log),
    log,
    onExit: (code) => {
      try {
        sessionBus.disconnect?.();
      } catch {}
      process.exit(code);
    },
  });
  const code = await svc.start();
  if (code !== 0) {
    err("tfm: couldn't own org.freedesktop.FileManager1 (see log above)");
    return 2;
  }
  out("tfm filemanager-service: owning org.freedesktop.FileManager1");
  // hold the name until killed — the process IS the service
  await new Promise(() => {});
  return 0;
};
