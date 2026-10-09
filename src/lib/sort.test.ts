import { describe, expect, test } from "bun:test";
import { cycleSortMode, naturalAscFor, syncSortState, type SortMode } from "./sort";

describe("cycleSortMode", () => {
  test("walks name↑ → size↓ → mtime↑ → type↑ → name↑ (menu naturals)", () => {
    expect(cycleSortMode("name")).toEqual({ sortBy: "size", sortAsc: false });
    expect(cycleSortMode("size")).toEqual({ sortBy: "mtime", sortAsc: true });
    expect(cycleSortMode("mtime")).toEqual({ sortBy: "type", sortAsc: true });
    expect(cycleSortMode("type")).toEqual({ sortBy: "name", sortAsc: true });
  });
});

describe("naturalAscFor", () => {
  test("matches the cycle naturals (size sorts descending)", () => {
    expect(naturalAscFor("name")).toBe(true);
    expect(naturalAscFor("size")).toBe(false);
    expect(naturalAscFor("mtime")).toBe(true);
    expect(naturalAscFor("type")).toBe(true);
  });
});

describe("syncSortState", () => {
  test("a mode change re-sorts in the new natural direction", () => {
    const st: { sortBy: SortMode; sortAsc: boolean } = { sortBy: "name", sortAsc: true };
    syncSortState(st, "size");
    expect(st).toEqual({ sortBy: "size", sortAsc: false });
  });

  test("an unchanged mode keeps a manual flip (menu toggle, cycle landing)", () => {
    const st: { sortBy: SortMode; sortAsc: boolean } = { sortBy: "type", sortAsc: false };
    syncSortState(st, "type");
    expect(st).toEqual({ sortBy: "type", sortAsc: false });
  });
});
