import { describe, expect, test } from "bun:test";
import {
  FILE_ICON_BY_EXT,
  fileIconFor,
  fileIsImage,
  fileIsVideo,
  loadGlobs2,
  mimeCategory,
  mimeForExt,
} from "./filetype";

describe("mimeCategory", () => {
  test("media-type prefixes map to their icon categories", () => {
    expect(mimeCategory("image/png")).toBe("file-image");
    expect(mimeCategory("video/mp4")).toBe("file-video");
    expect(mimeCategory("audio/flac")).toBe("file-music");
  });

  test("archive mimes map to zip-box", () => {
    expect(mimeCategory("application/zip")).toBe("zip-box");
    expect(mimeCategory("application/x-tar")).toBe("zip-box");
    expect(mimeCategory("application/vnd.android.package-archive")).toBe("zip-box");
  });

  test("pdf is its own category", () => {
    expect(mimeCategory("application/pdf")).toBe("file-pdf-box");
  });

  test("code-like mimes: text/x-*, known rich types, +xml/+json suffixes", () => {
    expect(mimeCategory("text/x-python")).toBe("file-code");
    expect(mimeCategory("text/html")).toBe("file-code");
    expect(mimeCategory("application/javascript")).toBe("file-code");
    expect(mimeCategory("application/atom+xml")).toBe("file-code");
    expect(mimeCategory("application/ld+json")).toBe("file-code");
  });

  test("media prefix wins over +xml suffix (svg is an image first)", () => {
    expect(mimeCategory("image/svg+xml")).toBe("file-image");
  });

  test("plain text/* and word-processor mimes are documents", () => {
    expect(mimeCategory("text/plain")).toBe("file-document");
    expect(mimeCategory("application/msword")).toBe("file-document");
    expect(mimeCategory("application/vnd.oasis.opendocument.text")).toBe("file-document");
  });

  test("optical disc images map to disc", () => {
    expect(mimeCategory("application/x-cd-image")).toBe("disc");
    expect(mimeCategory("application/vnd.efi.iso")).toBe("disc");
    expect(mimeCategory("application/x-compressed-iso")).toBe("disc");
    expect(mimeCategory("application/x-cue")).toBe("disc");
    expect(mimeCategory("application/x-nrg")).toBe("disc");
  });

  test("executables and MS packages map to their categories", () => {
    expect(mimeCategory("application/x-msdownload")).toBe("cog-box");
    expect(mimeCategory("application/vnd.debian.binary-package")).toBe("package");
    expect(mimeCategory("application/x-rpm")).toBe("package");
    expect(mimeCategory("application/vnd.ms-cab-compressed")).toBe("zip-box");
  });

  test("font/*, message/* and ebook/cert/torrent/db mimes map to their categories", () => {
    expect(mimeCategory("font/ttf")).toBe("file-font");
    expect(mimeCategory("font/woff2")).toBe("file-font");
    expect(mimeCategory("message/rfc822")).toBe("email");
    expect(mimeCategory("application/epub+zip")).toBe("book-open");
    expect(mimeCategory("application/pkix-cert")).toBe("certificate");
    expect(mimeCategory("application/x-x509-ca-cert")).toBe("certificate");
    expect(mimeCategory("application/x-bittorrent")).toBe("magnet");
    expect(mimeCategory("application/x-sqlite3")).toBe("database");
  });

  test("unknown mimes fall back to file", () => {
    expect(mimeCategory("application/octet-stream")).toBe("file");
    expect(mimeCategory("")).toBe("file");
  });
});

describe("fileIconFor", () => {
  test("known extensions hit the static table regardless of case", () => {
    expect(fileIconFor("app.ts")).toBe("file-code");
    expect(fileIconFor("PHOTO.JPG")).toBe("file-image");
    expect(fileIconFor("archive.7z")).toBe("zip-box");
  });

  test("disc images get the disc icon regardless of case", () => {
    expect(fileIconFor("ubuntu.iso")).toBe("disc");
    expect(fileIconFor("raspbian.IMG")).toBe("disc");
    expect(fileIconFor("game.bin")).toBe("disc");
    expect(fileIconFor("game.cue")).toBe("disc");
    expect(fileIconFor("disc.mdf")).toBe("disc");
    expect(fileIconFor("disc.nrg")).toBe("disc");
    expect(fileIconFor("game.cso")).toBe("disc");
  });

  test("executables, packages, fonts, books, certs, models, mail, torrents, db, VM disks", () => {
    expect(fileIconFor("setup.exe")).toBe("cog-box");
    expect(fileIconFor("setup.msi")).toBe("cog-box");
    expect(fileIconFor("run.BAT")).toBe("cog-box");
    expect(fileIconFor("lib.so")).toBe("cog-box");
    expect(fileIconFor("app.AppImage")).toBe("cog-box");
    expect(fileIconFor("pkg.deb")).toBe("package");
    expect(fileIconFor("pkg.rpm")).toBe("package");
    expect(fileIconFor("font.ttf")).toBe("file-font");
    expect(fileIconFor("font.OTF")).toBe("file-font");
    expect(fileIconFor("font.woff2")).toBe("file-font");
    expect(fileIconFor("book.epub")).toBe("book-open");
    expect(fileIconFor("book.mobi")).toBe("book-open");
    expect(fileIconFor("site.crt")).toBe("certificate");
    expect(fileIconFor("key.pem")).toBe("certificate");
    expect(fileIconFor("model.blend")).toBe("cube");
    expect(fileIconFor("part.dwg")).toBe("cube");
    expect(fileIconFor("mail.eml")).toBe("email");
    expect(fileIconFor("linux.torrent")).toBe("magnet");
    expect(fileIconFor("data.sqlite")).toBe("database");
    expect(fileIconFor("mac.dmg")).toBe("harddisk");
    expect(fileIconFor("disk.vhdx")).toBe("harddisk");
    expect(fileIconFor("app.apk")).toBe("android");
    expect(fileIconFor("app.aab")).toBe("android");
    expect(fileIconFor("cover.kra")).toBe("file-image");
    expect(fileIconFor("data.cab")).toBe("zip-box");
  });

  test("dotfiles and extensionless names fall back to file", () => {
    expect(fileIconFor(".bashrc")).toBe("file");
    expect(fileIconFor("Makefile")).toBe("file");
  });

  test("unknown extensions fall back to file (pre-globs2)", () => {
    expect(fileIconFor("data.xyzzy")).toBe("file");
  });
});

describe("fileIsImage", () => {
  test("static image extensions are images", () => {
    expect(fileIsImage("x.png")).toBe(true);
    expect(fileIsImage("x.WEBP")).toBe(true);
  });

  test("non-images and dotfiles are not images", () => {
    expect(fileIsImage("x.ts")).toBe(false);
    expect(fileIsImage("x.mp4")).toBe(false);
    expect(fileIsImage(".profile")).toBe(false);
  });
});

describe("fileIsVideo", () => {
  test("video extensions are videos", () => {
    expect(fileIsVideo("x.mp4")).toBe(true);
    expect(fileIsVideo("x.MKV")).toBe(true);
    expect(fileIsVideo("x.webm")).toBe(true);
  });

  // .ts is TypeScript for tfm even though globs2 classifies it video/mp2t —
  // the ext table must win over the mime db
  test(".ts stays TypeScript, dotfiles are not videos", () => {
    expect(fileIsVideo("x.ts")).toBe(false);
    expect(fileIsVideo(".profile")).toBe(false);
  });
});

describe("FILE_ICON_BY_EXT integrity", () => {
  test("every value is one of the known icon-name categories", () => {
    const known = new Set([
      "file-code",
      "file-document",
      "file-image",
      "file-video",
      "file-music",
      "zip-box",
      "file-pdf-box",
      "disc",
      "cog-box",
      "package",
      "file-font",
      "book-open",
      "database",
      "certificate",
      "cube",
      "email",
      "magnet",
      "harddisk",
      "android",
    ]);
    for (const cat of Object.values(FILE_ICON_BY_EXT)) expect(known.has(cat)).toBe(true);
  });

  test("keys are lowercase so the case-insensitive lookup path stays honest", () => {
    for (const ext of Object.keys(FILE_ICON_BY_EXT)) expect(ext).toBe(ext.toLowerCase());
  });

  test("every emitted category has a matching assets/icons/<name>.svg (slot names must match filenames exactly)", async () => {
    const { existsSync } = await import("node:fs");
    const { default: path } = await import("node:path");
    const dir = path.join(import.meta.dir, "../../assets/icons");
    const cats = new Set([...Object.values(FILE_ICON_BY_EXT), "file"]);
    for (const cat of cats) expect(existsSync(path.join(dir, `${cat}.svg`))).toBe(true);
  });
});

describe("loadGlobs2 + mimeForExt (integration, needs shared-mime-info)", () => {
  test("boot-load resolves common mimes and never throws when absent", async () => {
    await loadGlobs2();
    if (mimeForExt("png") === undefined) return;
    expect(mimeForExt("png")).toMatch(/^image\//);
    expect(mimeForExt("PNG")).toMatch(/^image\//);
    expect(mimeForExt("mp4")).toMatch(/^video\//);
    expect(mimeForExt("no-such-ext-xyzzy")).toBeUndefined();
  });
});
