import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DIRECTORY_MIME,
  defaultFileManagerMarker,
  defaultFileManagerPrev,
  isDesktopEntryInstalled,
  makeDefaultFileManagerOrchestration,
  probeDefaultFileManagerSync,
  queryFileManagerChoice,
  readFileManagerAnswer,
  recordFileManagerChoice,
  setDefaultFileManager,
  TFM_DESKTOP_ID,
} from "./default-filemanager";

// Leaf contract: "make tfm the default file manager?" Yes/No/Ask-again.
// Marker (under $XDG_STATE_HOME/tfm/, next to session.json — never a config
// key, so config-schema/config.example.toml/the settings schema stay
// untouched) records the user's answer: "yes" = set + never ask, "no" =
// never ask, "later" = ask again next boot.

const sandbox = (): string => mkdtempSync(path.join(os.tmpdir(), "tfm-defmgr-"));

describe("queryFileManagerChoice", () => {
  test("no marker and not the default yet: ask", () => {
    const dir = sandbox();
    expect(
      queryFileManagerChoice({
        currentDefault: () => "org.gnome.Nautilus.desktop",
        markerFile: () => path.join(dir, "choice"),
      }),
    ).toBe("ask");
  });

  test("no marker but already default: silent (nothing to ask)", () => {
    const dir = sandbox();
    expect(
      queryFileManagerChoice({
        currentDefault: () => TFM_DESKTOP_ID,
        markerFile: () => path.join(dir, "choice"),
      }),
    ).toBe("silent");
  });

  test("a failing currentDefault probe asks (detection must not wedge boot)", () => {
    const dir = sandbox();
    expect(
      queryFileManagerChoice({
        currentDefault: () => {
          throw new Error("no xdg-mime");
        },
        markerFile: () => path.join(dir, "choice"),
      }),
    ).toBe("ask");
  });

  test("marker yes/no always wins over the live probe (user already answered)", () => {
    const dir = sandbox();
    const marker = path.join(dir, "choice");
    writeFileSync(marker, "no\n");
    expect(
      queryFileManagerChoice({
        currentDefault: () => "org.gnome.Nautilus.desktop",
        markerFile: () => marker,
      }),
    ).toBe("silent");
    writeFileSync(marker, "yes\n");
    expect(
      queryFileManagerChoice({
        currentDefault: () => "org.gnome.Nautilus.desktop",
        markerFile: () => marker,
      }),
    ).toBe("silent");
  });

  test("marker later re-asks even when something else is the default", () => {
    const dir = sandbox();
    const marker = path.join(dir, "choice");
    writeFileSync(marker, "later\n");
    expect(
      queryFileManagerChoice({
        currentDefault: () => "org.gnome.Nautilus.desktop",
        markerFile: () => marker,
      }),
    ).toBe("ask");
  });

  test("garbage marker content asks again (a corrupt marker must not silence the prompt)", () => {
    const dir = sandbox();
    const marker = path.join(dir, "choice");
    writeFileSync(marker, "maybe\n");
    expect(
      queryFileManagerChoice({
        currentDefault: () => "org.gnome.Nautilus.desktop",
        markerFile: () => marker,
      }),
    ).toBe("ask");
  });
});

describe("recordFileManagerChoice", () => {
  test("persists yes/no/later and the query honors them", () => {
    const dir = sandbox();
    const marker = path.join(dir, "choice");
    const deps = {
      currentDefault: () => "org.gnome.Nautilus.desktop",
      markerFile: () => marker,
    };
    recordFileManagerChoice("later", deps);
    expect(queryFileManagerChoice(deps)).toBe("ask");
    recordFileManagerChoice("no", deps);
    expect(queryFileManagerChoice(deps)).toBe("silent");
    recordFileManagerChoice("yes", deps);
    expect(queryFileManagerChoice(deps)).toBe("silent");
  });

  test("a hostile marker path never throws (best-effort, like every tfm sink write)", () => {
    expect(() =>
      recordFileManagerChoice("no", {
        currentDefault: () => "",
        markerFile: () => "/proc/1/nope/choice",
      }),
    ).not.toThrow();
  });
});

describe("setDefaultFileManager", () => {
  test("set stashes the previous default and runs the exact xdg-mime argv", async () => {
    const dir = sandbox();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const out = await setDefaultFileManager("set", {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { exit: 0, output: "" };
      },
      currentDefault: () => "org.gnome.Nautilus.desktop",
      prevFile: () => path.join(dir, "prev"),
      entryInstalled: () => true,
    });
    expect(calls).toEqual([{ cmd: "xdg-mime", args: ["default", TFM_DESKTOP_ID, DIRECTORY_MIME] }]);
    expect(out.ok).toBe(true);
    expect(defaultFileManagerPrev({ prevFile: () => path.join(dir, "prev") })).toBe("org.gnome.Nautilus.desktop");
  });

  test("set refuses when the desktop entry isn't installed (never point mimeapps at a missing file)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const out = await setDefaultFileManager("set", {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { exit: 0, output: "" };
      },
      entryInstalled: () => false,
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("isn't installed");
    expect(calls).toEqual([]);
  });

  test("unset restores the STASHED previous default, never an invented one", async () => {
    const dir = sandbox();
    const prev = path.join(dir, "prev");
    writeFileSync(prev, "org.gnome.Nautilus.desktop\n");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const out = await setDefaultFileManager("unset", {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { exit: 0, output: "" };
      },
      prevFile: () => prev,
    });
    expect(calls).toEqual([{ cmd: "xdg-mime", args: ["default", "org.gnome.Nautilus.desktop", DIRECTORY_MIME] }]);
    expect(out.ok).toBe(true);
  });

  test("unset refuses a stashed value that isn't a desktop id (option-injection guard)", async () => {
    const dir = sandbox();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    for (const evil of ["-evil", "--help", "nautilus", "a/b.desktop", `${"x".repeat(300)}.desktop`]) {
      const prev = path.join(dir, "prev");
      writeFileSync(prev, `${evil}\n`);
      const out = await setDefaultFileManager("unset", {
        exec: async (cmd: string, args: string[]) => {
          calls.push({ cmd, args });
          return { exit: 0, output: "" };
        },
        prevFile: () => prev,
      });
      expect(out.ok, evil).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test("unset with no stashed previous refuses instead of clearing the default", async () => {
    const dir = sandbox();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const out = await setDefaultFileManager("unset", {
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { exit: 0, output: "" };
      },
      prevFile: () => path.join(dir, "prev"),
    });
    expect(out.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a failing xdg-mime reports the failure, never throws", async () => {
    const out = await setDefaultFileManager("set", {
      exec: async () => ({ exit: 1, output: "boom" }),
      entryInstalled: () => true,
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("boom");
  });
});

describe("probeDefaultFileManagerSync", () => {
  test("returns a string without throwing on machines without xdg-mime", () => {
    // observable contract only: never throws, always a string ("" = unknown).
    // The exact value depends on the machine, so no equality assert here.
    expect(typeof probeDefaultFileManagerSync()).toBe("string");
  });
});

describe("defaultFileManagerMarker", () => {
  test("lives next to the session state, honoring XDG_STATE_HOME", () => {
    // exact-path assert with the env set (a substring-only assert would pass
    // on a hardcoded ~/.local/state regression — session.test.ts precedent)
    const prev = process.env.XDG_STATE_HOME;
    const dir = sandbox();
    process.env.XDG_STATE_HOME = dir;
    try {
      expect(defaultFileManagerMarker()).toBe(path.join(dir, "tfm", "default-file-manager"));
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
    expect(defaultFileManagerMarker()).toContain(path.join("tfm", "default-file-manager"));
  });
});

describe("readFileManagerAnswer", () => {
  test("returns the raw yes/no/later answer, null when unanswered or garbage", () => {
    const dir = sandbox();
    const marker = path.join(dir, "choice");
    expect(readFileManagerAnswer({ markerFile: () => marker })).toBeNull();
    writeFileSync(marker, "yes\n");
    expect(readFileManagerAnswer({ markerFile: () => marker })).toBe("yes");
    writeFileSync(marker, "no\n");
    expect(readFileManagerAnswer({ markerFile: () => marker })).toBe("no");
    writeFileSync(marker, "later\n");
    expect(readFileManagerAnswer({ markerFile: () => marker })).toBe("later");
    writeFileSync(marker, "maybe\n");
    expect(readFileManagerAnswer({ markerFile: () => marker })).toBeNull();
  });
});

describe("makeDefaultFileManagerOrchestration", () => {
  test("the shared object reads the live probe on every call (never captured)", () => {
    // the wiring spreads this into the row ctx and calls .choice() for the
    // boot gate: if choice() ever dropped the live probe, an out-of-band
    // `xdg-mime default tfm.desktop` would keep prompting (B1 regression)
    const orch = makeDefaultFileManagerOrchestration();
    expect(typeof orch.current()).toBe("string");
    expect(["ask", "silent"]).toContain(orch.choice());
    expect([null, "yes", "no", "later"]).toContain(orch.answer());
  });

  test("choice() consults the live probe: already-default silences with no marker", () => {
    const dir = sandbox();
    const marker = path.join(dir, "choice");
    const orch = makeDefaultFileManagerOrchestration({
      currentDefault: () => TFM_DESKTOP_ID,
      markerFile: () => marker,
    });
    // no marker file written at all — silence comes from the probe alone
    expect(orch.choice()).toBe("silent");
    const asking = makeDefaultFileManagerOrchestration({
      currentDefault: () => "org.gnome.Nautilus.desktop",
      markerFile: () => marker,
    });
    expect(asking.choice()).toBe("ask");
  });
});

describe("isDesktopEntryInstalled", () => {
  test("finds the entry under XDG_DATA_HOME, misses when absent", () => {
    const prev = process.env.XDG_DATA_HOME;
    const dir = sandbox();
    process.env.XDG_DATA_HOME = dir;
    try {
      expect(isDesktopEntryInstalled({ dataDirs: () => [] })).toBe(false);
      const apps = path.join(dir, "applications");
      mkdirSync(apps, { recursive: true });
      writeFileSync(path.join(apps, "tfm.desktop"), "[Desktop Entry]\n");
      expect(isDesktopEntryInstalled({ dataDirs: () => [] })).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
    }
  });

  test("consults XDG_DATA_DIRS system dirs too", () => {
    const dir = sandbox();
    const apps = path.join(dir, "applications");
    mkdirSync(apps, { recursive: true });
    writeFileSync(path.join(apps, "tfm.desktop"), "[Desktop Entry]\n");
    const prevHome = process.env.XDG_DATA_HOME;
    const prevDirs = process.env.XDG_DATA_DIRS;
    process.env.XDG_DATA_HOME = path.join(dir, "empty-home");
    delete process.env.XDG_DATA_DIRS;
    try {
      expect(isDesktopEntryInstalled({ dataDirs: () => [dir] })).toBe(true);
      expect(isDesktopEntryInstalled({ dataDirs: () => [path.join(dir, "nowhere")] })).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevHome;
      if (prevDirs === undefined) delete process.env.XDG_DATA_DIRS;
      else process.env.XDG_DATA_DIRS = prevDirs;
    }
  });
});
