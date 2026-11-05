import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { describe, expect, it, vi } from "vitest";
import type { ImportPreview } from "./model";
import {
  appendComparisonFileBatch,
  comparisonDropSide,
  importSummaryFileBatch,
  mergeSummaryFilePaths,
  nativeFileDropAction,
} from "./summaryFiles";

function preview(paths: string[]): ImportPreview {
  return {
    date: "08.10.2026", totalRows: paths.length * 5, totalPersonnel: paths.length * 4,
    units: paths.map((path) => ({
      path, id: path, fileName: path, unitName: path, date: "08.10.2026",
      rowCount: 5, personnelCount: 4, authorizedStrength: 6,
    })),
  };
}

describe("summary file batches", () => {
  it("imports the entire first selection with one backend request", async () => {
    const paths = ["/1 РУБАК.xlsx", "/2 РУБАК.xlsx", "/3 РУБАК.xlsx"];
    const load = vi.fn(async (batch: string[]) => preview(batch));
    const result = await importSummaryFileBatch(null, paths, load);
    expect(load).toHaveBeenCalledExactlyOnceWith(paths);
    expect(result?.units.map((unit) => unit.path)).toEqual(paths);
    expect(result?.totalPersonnel).toBe(12);
  });

  it("appends a whole batch without losing the user's reordered existing units", async () => {
    const current = preview(["/2.xlsx", "/1.xlsx"]);
    const load = vi.fn(async (batch: string[]) => preview(batch));
    const result = await importSummaryFileBatch(current, ["/3.xlsx", "/4.xlsx", "/3.xlsx", "/1.xlsx"], load);
    expect(load).toHaveBeenCalledExactlyOnceWith(["/2.xlsx", "/1.xlsx", "/3.xlsx", "/4.xlsx"]);
    expect(result?.totalPersonnel).toBe(16);
    expect(current.units.map((unit) => unit.path)).toEqual(["/2.xlsx", "/1.xlsx"]);
  });

  it("allows adding one file to an existing group rather than validating the new batch in isolation", async () => {
    const load = vi.fn(async (batch: string[]) => {
      if (batch.length < 2) throw new Error("At least two files required");
      return preview(batch);
    });
    const result = await importSummaryFileBatch(preview(["/1.xlsx", "/2.xlsx"]), ["/3.xlsx"], load);
    expect(result?.units).toHaveLength(3);
    expect(load).toHaveBeenCalledExactlyOnceWith(["/1.xlsx", "/2.xlsx", "/3.xlsx"]);
  });

  it("deduplicates Windows drive and network paths while retaining their first spelling and order", () => {
    expect(mergeSummaryFilePaths(
      ["C:\\Reports\\1.xlsx", "\\\\Server\\Share\\2.xlsx"],
      ["c:/reports/1.XLSX", "//server/share/2.xlsx", "C:\\Reports\\3.xlsx", "", "  "],
    )).toEqual(["C:\\Reports\\1.xlsx", "\\\\Server\\Share\\2.xlsx", "C:\\Reports\\3.xlsx"]);
  });

  it("does not collapse distinct case-sensitive Unix files", () => {
    expect(mergeSummaryFilePaths(["/Reports/A.xlsx"], ["/Reports/a.xlsx", "/Reports/A.xlsx"]))
      .toEqual(["/Reports/A.xlsx", "/Reports/a.xlsx"]);
  });

  it("does not reimport a duplicate-only or empty drop", async () => {
    const current = preview(["C:\\1.xlsx", "C:\\2.xlsx"]);
    const load = vi.fn(async (paths: string[]) => preview(paths));
    expect(await importSummaryFileBatch(current, ["c:/1.xlsx", "C:\\2.xlsx"], load)).toBe(current);
    expect(await importSummaryFileBatch(current, [], load)).toBe(current);
    expect(await importSummaryFileBatch(null, [""], load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("validates old and new files together and leaves the previous selection intact on failure", async () => {
    const current = preview(["/1.xlsx", "/2.xlsx"]);
    const snapshot = structuredClone(current);
    const load = vi.fn(async (): Promise<ImportPreview> => {
      throw new Error("Не можна об’єднати БЧС за різні дати");
    });
    await expect(importSummaryFileBatch(current, ["/wrong-date.xlsx"], load)).rejects.toThrow("різні дати");
    expect(load).toHaveBeenCalledExactlyOnceWith(["/1.xlsx", "/2.xlsx", "/wrong-date.xlsx"]);
    expect(current).toEqual(snapshot);
  });
});

describe("native file drops", () => {
  const position = new PhysicalPosition(100, 100);

  it("handles native enter, hover and cancellation without importing early", () => {
    expect(nativeFileDropAction({ type: "enter", paths: ["/1.xlsx", "/2.xlsx"], position }, false))
      .toEqual({ dragging: true });
    expect(nativeFileDropAction({ type: "over", position }, false)).toEqual({ dragging: true });
    expect(nativeFileDropAction({ type: "leave" }, false)).toEqual({ dragging: false });
  });

  it("forwards every native dropped path as one batch", () => {
    const paths = ["/1.xlsx", "/2.xlsx", "/3.xlsx"];
    expect(nativeFileDropAction({ type: "drop", paths, position }, false))
      .toEqual({ dragging: false, paths });
  });

  it("ignores native file events while importing or internally reordering rows", () => {
    const event = { type: "drop" as const, paths: ["/1.xlsx", "/2.xlsx"], position };
    expect(nativeFileDropAction(event, true)).toEqual({ dragging: false });
    expect(nativeFileDropAction(event, false, true)).toEqual({ dragging: false });
  });
});

describe("comparison batch routing", () => {
  it.each(["before", "after"] as const)("appends and deduplicates only the selected %s date", (side) => {
    const initial = { before: ["/before-1.xlsx"], after: ["/after-1.xlsx"] };
    const next = appendComparisonFileBatch(initial, side, ["/2.xlsx", "/3.xlsx", "/2.xlsx"]);
    expect(next[side]).toEqual([...initial[side], "/2.xlsx", "/3.xlsx"]);
    const other = side === "before" ? "after" : "before";
    expect(next[other]).toBe(initial[other]);
    expect(initial[side]).toHaveLength(1);
  });

  it("keeps deduplication independent between the two date groups", () => {
    const files = appendComparisonFileBatch({ before: ["/same.xlsx"], after: [] }, "after", ["/same.xlsx"]);
    expect(files).toEqual({ before: ["/same.xlsx"], after: ["/same.xlsx"] });
  });

  it("routes a drop into the card under the native pointer, including Windows display scaling", () => {
    const bounds = {
      before: { left: 10, right: 210, top: 30, bottom: 330 },
      after: { left: 230, right: 430, top: 30, bottom: 330 },
    };
    expect(comparisonDropSide({ x: 200, y: 200 }, bounds, "after", 2)).toBe("before");
    expect(comparisonDropSide({ x: 600, y: 200 }, bounds, "before", 2)).toBe("after");
    expect(comparisonDropSide({ x: 1000, y: 1000 }, bounds, "before", 2)).toBe("before");
    expect(comparisonDropSide({ x: 1000, y: 1000 }, bounds, "after", 2)).toBe("after");
  });
});
