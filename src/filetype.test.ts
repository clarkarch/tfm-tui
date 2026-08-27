import { describe, expect, test } from "bun:test";
import {
  FILE_ICON_BY_EXT,
  fileIconFor,
  fileIsImage,
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

describe("FILE_ICON_BY_EXT integrity", () => {
  test("every value is one of the known icon-name categories", () => {
    const known = new Set([
      "file-code", "file-document", "file-image", "file-video",
      "file-music", "zip-box", "file-pdf-box",
    ]);
    for (const cat of Object.values(FILE_ICON_BY_EXT)) expect(known.has(cat)).toBe(true);
  });

  test("keys are lowercase so the case-insensitive lookup path stays honest", () => {
    for (const ext of Object.keys(FILE_ICON_BY_EXT)) expect(ext).toBe(ext.toLowerCase());
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
