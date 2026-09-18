import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { trashDir } from "./fsutil";
import { makeTrashConfirms, makeTrashOps, trashOrigPath, type TrashOpsSink } from "./trashops";

const oldDataHome = process.env.XDG_DATA_HOME;
const oldHome = process.env.HOME;
afterEach(() => {
  if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldDataHome;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
});

const sandbox = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tfm-trash-"));
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.HOME = root; // restoreFromTrash may mkdir under orig path
  return root;
};

// the ops run fire-and-forget async — a fixed sleep races real fs work under
// suite load, so poll for a condition (or just settle when no fs change is
// expected) with a generous deadline
const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  await Bun.sleep(10);
};

const recordingSink = (): TrashOpsSink & {
  notes: string[];
  batches: { label: string; units: number; redos: number }[];
} => {
  const notes: string[] = [];
  const batches: { label: string; units: number; redos: number }[] = [];
  return {
    notes,
    batches,
    pushUndoBatch: (label, units, redos) => batches.push({ label, units: units.length, redos: redos.length }),
    notify: (msg, title, level) => notes.push(`notify:${title ?? ""}:${level ?? ""}:${msg}`),
    renderAll: () => notes.push("renderAll"),
  };
};

describe("trashPaths", () => {
  test("moves into XDG trash, writes trashinfo, pushes paired undo batch", async () => {
    const root = sandbox();
    try {
      const file = path.join(root, "doomed.txt");
      writeFileSync(file, "bye");
      const sink = recordingSink();
      const ops = makeTrashOps(sink);
      ops.trashPaths([file]);

      const hit = path.join(trashDir(), "files", "doomed.txt");
      await settleUntil(() => existsSync(hit));
      expect(existsSync(hit)).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(path.join(trashDir(), "info", "doomed.txt.trashinfo"))).toBe(true);
      expect(sink.batches.length).toBe(1);
      expect(sink.batches[0]!.label).toBe("trash 1 item");
      expect(sink.batches[0]!.units).toBe(1);
      expect(sink.batches[0]!.redos).toBe(1);
      expect(sink.notes.some((n) => n === "notify:trash:success:Trashed 1 item · ctrl+z to undo")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failure is counted with reason, not thrown", async () => {
    const root = sandbox();
    try {
      const sink = recordingSink();
      const ops = makeTrashOps(sink);
      ops.trashPaths([path.join(root, "missing.bin")]);
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:trash failed")));
      expect(sink.notes.some((n) => n.includes("Trashed 0 of 1") && n.includes("FAILED"))).toBe(true);
      expect(sink.notes.some((n) => n.startsWith("notify:trash failed"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("onEvent fires with the stable op name (trash, not trashPaths)", async () => {
    const root = sandbox();
    try {
      const events: Array<{ op: string; paths: string[] }> = [];
      const file = path.join(root, "doomed.txt");
      writeFileSync(file, "bye");
      const sink = recordingSink();
      const ops = makeTrashOps({ ...sink, onEvent: (op, paths) => events.push({ op, paths }) });
      await ops.trashPaths([file]);
      expect(events).toEqual([{ op: "trash", paths: [file] }]);
      // a throwing listener never breaks the op
      const ops2 = makeTrashOps({
        ...sink,
        onEvent: () => {
          throw new Error("listener-boom");
        },
      });
      const file2 = path.join(root, "doomed2.txt");
      writeFileSync(file2, "bye");
      await expect(ops2.trashPaths([file2])).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trashOrigPath", () => {
  test("parses Path= with url-decoding, file:// prefix tolerated", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "info", "a.txt.trashinfo"), "[Trash Info]\nPath=/tmp/a%20b.txt\n");
      writeFileSync(path.join(trashDir(), "info", "b.txt.trashinfo"), "[Trash Info]\nPath=file:///tmp/b.txt\n");
      expect(await trashOrigPath("a.txt")).toBe("/tmp/a b.txt");
      expect(await trashOrigPath("b.txt")).toBe("/tmp/b.txt");
      expect(await trashOrigPath("nope.txt")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("restoreFromTrash", () => {
  test("moves back to original location and removes trashinfo", async () => {
    const root = sandbox();
    try {
      const origDir = path.join(root, "orig");
      mkdirSync(origDir, { recursive: true });
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "gone.txt"), "data");
      writeFileSync(path.join(trashDir(), "info", "gone.txt.trashinfo"), `[Trash Info]\nPath=${origDir}/gone.txt\n`);
      const sink = recordingSink();
      makeTrashOps(sink).restoreFromTrash([path.join(trashDir(), "files", "gone.txt")]);
      await settleUntil(() => existsSync(path.join(origDir, "gone.txt")));
      expect(existsSync(path.join(origDir, "gone.txt"))).toBe(true);
      expect(existsSync(path.join(trashDir(), "info", "gone.txt.trashinfo"))).toBe(false);
      expect(sink.notes.some((n) => n === "notify:restore:success:Restored 1 item · ctrl+z to undo")).toBe(true);
      // restore is reversible: undo batch re-trashes the restored item
      expect(sink.batches.length).toBe(1);
      expect(sink.batches[0]!.label).toBe("restore 1 item");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recreated original is never clobbered: restore bumps to (copy)", async () => {
    const root = sandbox();
    try {
      const origDir = path.join(root, "orig");
      mkdirSync(origDir, { recursive: true });
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "gone.txt"), "restored-data");
      writeFileSync(path.join(trashDir(), "info", "gone.txt.trashinfo"), `[Trash Info]\nPath=${origDir}/gone.txt\n`);
      writeFileSync(path.join(origDir, "gone.txt"), "current-data");
      const sink = recordingSink();
      makeTrashOps(sink).restoreFromTrash([path.join(trashDir(), "files", "gone.txt")]);
      await settleUntil(() => existsSync(path.join(origDir, "gone (copy).txt")));
      expect(readFileSync(path.join(origDir, "gone.txt"), "utf8")).toBe("current-data");
      expect(readFileSync(path.join(origDir, "gone (copy).txt"), "utf8")).toBe("restored-data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("deleteForever / emptyTrash", () => {
  test("delete removes files+info without undo batch", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "x.txt"), "1");
      writeFileSync(path.join(trashDir(), "info", "x.txt.trashinfo"), "[Trash Info]\nPath=/tmp/x\n");
      const sink = recordingSink();
      makeTrashOps(sink).deleteForever([path.join(trashDir(), "files", "x.txt")]);
      await settleUntil(() => !existsSync(path.join(trashDir(), "info", "x.txt.trashinfo")));
      expect(existsSync(path.join(trashDir(), "files", "x.txt"))).toBe(false);
      expect(existsSync(path.join(trashDir(), "info", "x.txt.trashinfo"))).toBe(false);
      expect(sink.batches.length).toBe(0);
      expect(sink.notes.some((n) => n === "notify:delete:success:Deleted 1 item · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emptyTrash wipes everything and reports count", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "a"), "1");
      writeFileSync(path.join(trashDir(), "files", "b"), "2");
      const sink = recordingSink();
      makeTrashOps(sink).emptyTrash();
      await settleUntil(() => !existsSync(path.join(trashDir(), "files", "a")));
      expect(existsSync(path.join(trashDir(), "files", "a"))).toBe(false);
      expect(sink.notes.some((n) => n === "notify:empty:success:Emptied 2 items · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emptyTrash with unreadable dir notifies failure", async () => {
    const root = sandbox();
    try {
      const sink = recordingSink();
      makeTrashOps(sink).emptyTrash();
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:empty failed:error:Could not read trash")));
      expect(sink.notes.some((n) => n.startsWith("notify:empty failed:error:Could not read trash"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("makeTrashConfirms", () => {
  type Confirmed = { message: string; yesLabel: string; danger?: boolean };
  const mkEnv = () => {
    const asked: Confirmed[] = [];
    const fired: string[] = [];
    let onYes: (() => void) | null = null;
    const confirms = makeTrashConfirms({
      confirm: (message, yesLabel, cb, danger) => {
        asked.push({ message, yesLabel, danger });
        onYes = cb;
      },
      emptyTrash: () => {
        fired.push("empty");
      },
      deleteForever: (paths) => {
        fired.push(`delete:${paths.join(",")}`);
      },
    });
    return { asked, fired, confirms, runYes: () => onYes?.() };
  };

  test("empty-trash prompt names the count, exact verb and danger flag", () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "a"), "1");
      writeFileSync(path.join(trashDir(), "files", "b"), "2");
      const { asked, confirms, runYes, fired } = mkEnv();
      confirms.confirmEmptyTrash();
      expect(asked[0]).toEqual({
        message: "Empty Trash (2 items)? This cannot be undone.",
        yesLabel: "Empty Trash",
        danger: true,
      });
      runYes();
      expect(fired).toEqual(["empty"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty-trash prompt omits the count when the trash is unreadable", () => {
    const root = sandbox();
    try {
      const { asked, confirms } = mkEnv();
      confirms.confirmEmptyTrash();
      expect(asked[0]!.message).toBe("Empty Trash? This cannot be undone.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("delete-forever prompt pluralizes and carries the paths into the action", () => {
    const { asked, confirms, runYes, fired } = mkEnv();
    confirms.confirmDeleteForever(["/t/a"]);
    expect(asked[0]!.message).toBe("Permanently delete 1 item? This cannot be undone.");
    expect(asked[0]!.yesLabel).toBe("Delete permanently");
    expect(asked[0]!.danger).toBe(true);
    runYes();
    expect(fired).toEqual(["delete:/t/a"]);

    confirms.confirmDeleteForever(["/t/a", "/t/b"]);
    expect(asked[1]!.message).toBe("Permanently delete 2 items? This cannot be undone.");
    runYes();
    expect(fired).toEqual(["delete:/t/a", "delete:/t/a,/t/b"]);
  });

  test("nothing happens until the user confirms (onYes not auto-invoked)", () => {
    const { confirms, fired } = mkEnv();
    confirms.confirmEmptyTrash();
    confirms.confirmDeleteForever(["/x"]);
    expect(fired).toEqual([]);
  });
});

describe("delete progress driver", () => {
  const W = (p: string, s = "x") => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, s);
  };

  // the real wiring maps the driver onto prog+toast; here it records the
  // driver contract and its sink drives the real rmTreeProgress engine
  const fakeDriver = (opts: { cancelAfterFiles?: number } = {}) => {
    const calls: string[] = [];
    let cancelled = false;
    let done = 0;
    const driver: NonNullable<TrashOpsSink["deleteProgress"]> = {
      sink: {
        checkpoint: async () => {
          if (cancelled) throw new Error("cancelled");
        },
        paused: () => false,
        cancelled: () => cancelled,
        addBytes: () => {},
        fileDone: () => {
          done++;
          if (opts.cancelAfterFiles !== undefined && done >= opts.cancelAfterFiles) cancelled = true;
        },
        setStream: () => {},
        clearStream: () => {},
        repaint: () => {},
      },
      start: (files, bytes) => calls.push(`start:${files}:${bytes}`),
      cancelled: () => cancelled,
      finish: (msg) => calls.push(`finish:${msg}`),
      stop: () => calls.push("stop"),
    };
    return { driver, calls, files: () => done };
  };

  test("deleteForever pre-scans totals, streams the engine, finishes the toast", async () => {
    const root = sandbox();
    try {
      const tree = path.join(root, "tree");
      W(path.join(tree, "a.txt"), "AAA");
      W(path.join(tree, "sub", "b.txt"), "BB");
      const sink = recordingSink();
      const p = fakeDriver();
      sink.deleteProgress = p.driver;
      makeTrashOps(sink).deleteForever([tree]);
      await settleUntil(() => p.calls.includes("stop"));
      expect(existsSync(tree)).toBe(false);
      expect(p.calls).toContain("start:2:5");
      expect(p.calls).toContain("finish:✓ Deleted 1");
      expect(sink.notes.some((n) => n === "notify:delete:success:Deleted 1 item · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancel stops mid-tree, reports the partial removal, keeps what's left", async () => {
    const root = sandbox();
    try {
      const tree = path.join(root, "tree");
      W(path.join(tree, "a.txt"), "A");
      W(path.join(tree, "b.txt"), "B");
      W(path.join(tree, "c.txt"), "C");
      const sink = recordingSink();
      const p = fakeDriver({ cancelAfterFiles: 1 });
      sink.deleteProgress = p.driver;
      makeTrashOps(sink).deleteForever([tree]);
      await settleUntil(() => p.calls.includes("stop"));
      expect(existsSync(tree)).toBe(true);
      expect(p.files()).toBe(1);
      expect(p.calls).toContain("finish:✗ Delete cancelled");
      expect(sink.notes.some((n) => n === "notify:delete cancelled:info:Delete cancelled · 0 of 1 removed")).toBe(true);
      expect(sink.batches.length).toBe(0); // irreversible by design
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emptyTrash streams through the same driver", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "a"), "1");
      writeFileSync(path.join(trashDir(), "files", "b"), "2");
      const sink = recordingSink();
      const p = fakeDriver();
      sink.deleteProgress = p.driver;
      makeTrashOps(sink).emptyTrash();
      await settleUntil(() => p.calls.includes("stop"));
      expect(p.calls).toContain("start:2:2");
      expect(p.calls).toContain("finish:✓ Emptied 2");
      expect(sink.notes.some((n) => n === "notify:empty:success:Emptied 2 items · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trash pre-op veto", () => {
  test("a beforeFileOp hook blocks trashing; the file stays put", async () => {
    const root = sandbox();
    const { sharedPluginHooks } = await import("../lib/plugin-hooks");
    const off = sharedPluginHooks().onBeforeFileOp((p) =>
      p.op === "trash" ? { skip: true, reason: "nope" } : undefined,
    );
    try {
      const file = path.join(root, "keep.txt");
      writeFileSync(file, "keep");
      const sink = recordingSink();
      makeTrashOps(sink).trashPaths([file]);
      await settleUntil(() => sink.notes.length > 0);
      expect(existsSync(file)).toBe(true);
      expect(sink.notes.some((n) => n === "notify:blocked:info:Blocked by plugin: nope")).toBe(true);
      expect(sink.notes.some((n) => n.startsWith("notify:blocked:"))).toBe(true);
      expect(sink.batches.length).toBe(0);
    } finally {
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trashPaths network guard", () => {
  test("refuses a gvfs path instead of writing a bogus local .trashinfo", async () => {
    const oldRuntime = process.env.XDG_RUNTIME_DIR;
    const root = sandbox();
    process.env.XDG_RUNTIME_DIR = "/run/user/4242";
    try {
      const sink = recordingSink();
      const ops = makeTrashOps(sink);
      await ops.trashPaths(["/run/user/4242/gvfs/sftp:host=x,user=y/doomed.txt"]);
      expect(sink.batches.length).toBe(0);
      expect(sink.notes.some((n) => n.includes("Trash isn't available on network locations"))).toBe(true);
    } finally {
      if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = oldRuntime;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// chmod-based permission tests never fail as uid 0 (root bypasses
// file perms), so the whole block is skipped there with a reason
const describeNonRoot = process.getuid?.() === 0 ? describe.skip : describe;
describeNonRoot("sudo escalation", () => {
  // fake sudoExec: lift write on operand parents during exec (rm needs the
  // containing dir), restoring exact modes after — models root without sudo
  const seenArgv: string[][] = [];
  const fakeSudoExec = async (argv: string[]) => {
    seenArgv.push(argv);
    const rest = (argv as string[]).slice(2);
    const { chmodSync, statSync } = await import("node:fs");
    const lifted: Array<[string, number]> = [];
    const dashIdx = rest.indexOf("--");
    if (dashIdx >= 0) {
      for (const operand of rest.slice(dashIdx + 1)) {
        const parent = path.dirname(operand);
        try {
          if (!existsSync(parent)) continue;
          const mode = statSync(parent).mode & 0o777;
          if (!(mode & 0o200) && !lifted.some(([p]) => p === parent)) {
            lifted.push([parent, mode]);
            chmodSync(parent, mode | 0o700);
          }
        } catch {}
      }
    }
    try {
      const proc = Bun.spawn(rest, { stdout: "ignore", stderr: "pipe" });
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      return { status: proc.exitCode, stderr: err };
    } finally {
      for (const [p, mode] of lifted) {
        try {
          if (existsSync(p)) chmodSync(p, mode);
        } catch {}
      }
    }
  };
  test("deleteForever in read-only dir fails plain, succeeds with sudo fake", async () => {
    const root = sandbox();
    try {
      const { chmodSync } = await import("node:fs");
      const dir = path.join(root, "locked");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "victim.txt"), "x");
      chmodSync(dir, 0o555);

      const plain = recordingSink();
      await makeTrashOps(plain).deleteForever([path.join(dir, "victim.txt")]);
      expect(plain.notes.some((n) => n.includes("FAILED") && n.includes("permission denied"))).toBe(true);
      expect(existsSync(path.join(dir, "victim.txt"))).toBe(true);

      let gates = 0;
      const esc = recordingSink();
      (esc as Record<string, unknown>).ensureSudo = async () => {
        gates++;
        return true;
      };
      (esc as Record<string, unknown>).sudoExec = fakeSudoExec;
      await makeTrashOps(esc).deleteForever([path.join(dir, "victim.txt")]);
      expect(gates).toBe(1);
      chmodSync(dir, 0o755);
      expect(existsSync(path.join(dir, "victim.txt"))).toBe(false);
      expect(esc.notes.some((n) => n.includes("Deleted 1 item") && n.includes("cannot be undone"))).toBe(true);
      const rms = seenArgv.filter((a) => a[2] === "rm");
      expect(rms.length).toBe(1);
      expect(rms[0]!.slice(0, 5).join(" ")).toBe("sudo -n rm -rf --");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emptyTrash removes privileged entries via sudo with one gate", async () => {
    const root = sandbox();
    try {
      const { chmodSync } = await import("node:fs");
      // seed the sandboxed trash directly: info/ readable, files/ locked
      const filesDir = path.join(root, "data", "Trash", "files");
      const infoDir = path.join(root, "data", "Trash", "info");
      mkdirSync(filesDir, { recursive: true });
      mkdirSync(infoDir, { recursive: true });
      writeFileSync(path.join(filesDir, "stuck.txt"), "x");
      writeFileSync(
        path.join(infoDir, "stuck.txt.trashinfo"),
        `[Trash Info]\nPath=${path.join(root, "stuck.txt")}\nDeletionDate=2026-01-01T00:00:00Z\n`,
      );
      chmodSync(filesDir, 0o555);

      const esc = recordingSink();
      let gates = 0;
      (esc as Record<string, unknown>).ensureSudo = async () => {
        gates++;
        return true;
      };
      (esc as Record<string, unknown>).sudoExec = fakeSudoExec;
      await makeTrashOps(esc).emptyTrash();
      expect(gates).toBe(1);
      chmodSync(filesDir, 0o755);
      expect(existsSync(path.join(filesDir, "stuck.txt"))).toBe(false);
      expect(esc.notes.some((n) => n.includes("Emptied 1 item"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("trash and restore never escalate: gate stays untouched on permission failure", async () => {
    const root = sandbox();
    const { chmodSync } = await import("node:fs");
    const dir = path.join(root, "locked");
    try {
      // trashPaths on a root-owned-style file: lock the containing dir so the
      // move fails, with a gate that throws if anyone calls it
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "doomed.txt"), "bye");
      chmodSync(dir, 0o555);

      const sink = recordingSink();
      (sink as Record<string, unknown>).ensureSudo = async (): Promise<boolean> => {
        throw new Error("trash must never ask for sudo");
      };
      // unhandled rejections surface as test failures; callers use .catch
      await makeTrashOps(sink).trashPaths([path.join(dir, "doomed.txt")]);
      expect(sink.notes.some((n) => n.includes("FAILED") && n.includes("permission denied"))).toBe(true);
      expect(existsSync(path.join(dir, "doomed.txt"))).toBe(true);

      // restore: seed a trash entry whose original dir is locked
      const filesDir = path.join(root, "data", "Trash", "files");
      const infoDir = path.join(root, "data", "Trash", "info");
      mkdirSync(filesDir, { recursive: true });
      mkdirSync(infoDir, { recursive: true });
      const target = path.join(dir, "back.txt");
      writeFileSync(path.join(filesDir, "back.txt"), "data");
      writeFileSync(
        path.join(infoDir, "back.txt.trashinfo"),
        `[Trash Info]\nPath=${target}\nDeletionDate=2026-01-01T00:00:00Z\n`,
      );
      const sink2 = recordingSink();
      (sink2 as Record<string, unknown>).ensureSudo = async (): Promise<boolean> => {
        throw new Error("restore must never ask for sudo");
      };
      await makeTrashOps(sink2).restoreFromTrash([path.join(filesDir, "back.txt")]);
      expect(sink2.notes.some((n) => n.includes("FAILED") && n.includes("permission denied"))).toBe(true);
      expect(existsSync(path.join(filesDir, "back.txt"))).toBe(true);
    } finally {
      try {
        chmodSync(dir, 0o755);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });
});
