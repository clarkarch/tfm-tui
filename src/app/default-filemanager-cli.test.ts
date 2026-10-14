import { describe, expect, test } from "bun:test";
import { parseDefaultFileManagerArgs, runDefaultFileManagerCli } from "./default-filemanager-cli";

// Headless `tfm default-filemanager [status|set|unset]` (no TUI boot): the
// scriptable/SSH twin of the first-boot prompt + settings row. Pure dispatch
// is separated from the xdg-mime side so dispatch is unit-testable.

describe("parseDefaultFileManagerArgs", () => {
  test("bare subcommand reports status (read-only, like bare `tfm plugins` lists)", () => {
    expect(parseDefaultFileManagerArgs([]).cmd).toBe("status");
  });

  test("help spellings show help", () => {
    expect(parseDefaultFileManagerArgs(["help"]).cmd).toBe("help");
    expect(parseDefaultFileManagerArgs(["--help"]).cmd).toBe("help");
    expect(parseDefaultFileManagerArgs(["-h"]).cmd).toBe("help");
  });

  test("status/set/unset/forget parse; unknown is an error", () => {
    expect(parseDefaultFileManagerArgs(["status"]).cmd).toBe("status");
    expect(parseDefaultFileManagerArgs(["set"]).cmd).toBe("set");
    expect(parseDefaultFileManagerArgs(["unset"]).cmd).toBe("unset");
    expect(parseDefaultFileManagerArgs(["forget"]).cmd).toBe("forget");
    const bad = parseDefaultFileManagerArgs(["make-default-now"]);
    expect(bad.cmd).toBe("help");
    expect(bad.error).toContain("unknown");
  });
});

describe("runDefaultFileManagerCli", () => {
  const collect = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        out: (s: string) => out.push(s),
        err: (s: string) => err.push(s),
      },
    };
  };

  test("status reports the current handler (exit 0 either way)", async () => {
    const c = collect();
    const code = await runDefaultFileManagerCli(["status"], {
      ...c.deps,
      currentDefault: () => "org.gnome.Nautilus.desktop",
      markerFile: () => "/nonexistent/marker",
    });
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("org.gnome.Nautilus.desktop");
  });

  test("status names tfm when tfm is the default", async () => {
    const c = collect();
    await runDefaultFileManagerCli(["status"], {
      ...c.deps,
      currentDefault: () => "tfm.desktop",
      markerFile: () => "/nonexistent/marker",
    });
    expect(c.out.join("\n")).toContain("tfm.desktop");
  });

  test("set records yes and reports the outcome", async () => {
    const c = collect();
    let recorded = "";
    const code = await runDefaultFileManagerCli(["set"], {
      ...c.deps,
      recordChoice: (a: string) => {
        recorded = a;
      },
      setDefault: async () => ({ ok: true, message: "tfm is now the default file manager" }),
    });
    expect(code).toBe(0);
    expect(recorded).toBe("yes");
    expect(c.out.join("\n")).toContain("tfm is now the default");
  });

  test("status tells the whole truth: handler, recorded answer, entry check", async () => {
    const c = collect();
    const code = await runDefaultFileManagerCli(["status"], {
      ...c.deps,
      currentDefault: () => "org.gnome.Nautilus.desktop",
      recordedAnswer: () => "yes",
      entryInstalled: () => true,
    });
    expect(code).toBe(0);
    const text = c.out.join("\n");
    // handler line + stale-yes callout (recorded yes, system uses nautilus)
    expect(text).toContain("org.gnome.Nautilus.desktop");
    expect(text).toContain("recorded answer: yes");
    expect(text).toContain("not in effect");
  });

  test("status is quiet when settled (tfm default + recorded yes)", async () => {
    const c = collect();
    await runDefaultFileManagerCli(["status"], {
      ...c.deps,
      currentDefault: () => "tfm.desktop",
      recordedAnswer: () => "yes",
      entryInstalled: () => true,
    });
    const text = c.out.join("\n");
    expect(text).toContain("tfm.desktop");
    expect(text).not.toContain("not in effect");
  });

  test("forget deletes the marker so the prompt asks again", async () => {
    const c = collect();
    let forgotten = 0;
    const code = await runDefaultFileManagerCli(["forget"], {
      ...c.deps,
      forgetChoice: () => {
        forgotten++;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(forgotten).toBe(1);
    expect(c.out.join("\n")).toContain("forgotten");
  });

  test("a failing set exits 1 and records nothing (a failed yes must re-ask)", async () => {
    const c = collect();
    let recorded = "";
    const code = await runDefaultFileManagerCli(["set"], {
      ...c.deps,
      recordChoice: (a: string) => {
        recorded = a;
      },
      setDefault: async () => ({ ok: false, message: "boom" }),
    });
    expect(code).toBe(1);
    expect(recorded).toBe("");
    expect(c.err.join("\n")).toContain("boom");
  });

  test("unset records no and restores the stashed handler", async () => {
    const c = collect();
    let recorded = "";
    const code = await runDefaultFileManagerCli(["unset"], {
      ...c.deps,
      recordChoice: (a: string) => {
        recorded = a;
      },
      setDefault: async () => ({ ok: true, message: "nautilus is the default again" }),
    });
    expect(code).toBe(0);
    expect(recorded).toBe("no");
  });

  test("forget deletes the marker so the prompt asks again", async () => {
    const c = collect();
    let forgotten = 0;
    const code = await runDefaultFileManagerCli(["forget"], {
      ...c.deps,
      forgetChoice: () => {
        forgotten++;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(forgotten).toBe(1);
    expect(c.out.join("\n")).toContain("forgotten");
  });

  test("service-install writes the activator for this binary", async () => {
    const c = collect();
    const written: Array<{ file: string; content: string }> = [];
    const code = await runDefaultFileManagerCli(["service-install"], {
      ...c.deps,
      serviceFile: () => "/tmp/svc/org.freedesktop.FileManager1.service",
      serviceExec: () => "/home/u/.local/bin/tfm",
      writeService: (file: string, content: string) => written.push({ file, content }),
    });
    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]!.content).toContain("Name=org.freedesktop.FileManager1");
    expect(written[0]!.content).toContain("Exec=/home/u/.local/bin/tfm --filemanager-service");
    expect(c.out.join("\n")).toContain("service installed");
  });

  test("service-remove deletes the activator", async () => {
    const c = collect();
    let removed = "";
    const code = await runDefaultFileManagerCli(["service-remove"], {
      ...c.deps,
      serviceFile: () => "/tmp/svc/org.freedesktop.FileManager1.service",
      removeService: (file: string) => {
        removed = file;
      },
    });
    expect(code).toBe(0);
    expect(removed).toBe("/tmp/svc/org.freedesktop.FileManager1.service");
    expect(c.out.join("\n")).toContain("service removed");
  });
});
