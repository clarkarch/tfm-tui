import os from "node:os";
import path from "node:path";
import { errMessage } from "../lib/uiutil";
import { planShowFolders, planShowItems, type ShowPlan } from "../dnd/filemanager1";

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
};

type ServiceDeps = {
  bus: BusLike;
  openPlan(plan: ShowPlan): void;
  log(msg: string): void;
  // builds the exported interface object (lazy dbus-next import — prod only;
  // tests inject a stub so start() never touches the real bus modules)
  buildInterface?: () => Promise<unknown>;
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
      // DO_NOT_QUEUE = 4 (dbus-next exposes NameFlag; the fake bus ignores it)
      result = await deps.bus.requestName(SERVICE_NAME, 4);
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
export const fileManagerServiceFile = (): string =>
  path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"),
    "dbus-1",
    "services",
    `${SERVICE_NAME}.service`,
  );

export const fileManagerServiceEntry = (execPath: string): string =>
  `[D-BUS Service]\nName=${SERVICE_NAME}\nExec=${execPath} --filemanager-service\n`;

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
  const svc = makeFileManagerService({
    bus: bus.sessionBus(),
    openPlan: (plan) => openPlanWithEntry(plan, launchApp, desktopFilePath, log),
    log,
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
