import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StripsReportView from "./StripsReportView";
import {
  CREW_WITHOUT_POSITION_NOTE,
  POSITION_WITHOUT_CREW_NOTE,
  calculateStripsSummary,
  validateStripsReportErrors,
} from "./strips";
import {
  createEmptyStripsRegistry,
  createDemoStripsRegistry,
  createRegistryAssignment,
  createRegistryCrew,
  createRegistryPosition,
  isEffectivelyEmptyStripsRegistry,
  normalizeStripsRegistry,
  registryToStripsReport,
  validateStripsRegistry,
  type StripsRegistryData,
} from "./stripsRegistry";

function validRegistry(): StripsRegistryData {
  const crew = {
    ...createRegistryCrew(),
    name: "СОКІЛ-1",
    unit: "1 РУБАК",
    uavType: "ФПВ" as const,
    readiness: "БГ" as const,
    duty: "БЧ" as const,
    assets: "FPV 10",
  };
  const position = {
    ...createRegistryPosition(),
    name: "ПОЗИЦІЯ СОКІЛ",
    strip: "Смуга ПІВНІЧ",
    unit: "1 РУБАК",
    uavType: "ФПВ" as const,
    readiness: "БГ" as const,
    bro: "БРО-1",
    area: "РАЙОН ПІВНІЧ",
    direction: "Північний напрямок",
  };
  const assignment = {
    ...createRegistryAssignment(),
    crewId: crew.id,
    positionId: position.id,
  };
  return {
    ...createEmptyStripsRegistry("2026-10-14"),
    crews: [crew],
    positions: [position],
    assignments: [assignment],
  };
}

describe("strips registry", () => {
  it("recognizes only truly empty drafts as safe to seed with demo data", () => {
    const empty = createEmptyStripsRegistry("2026-10-14");
    expect(isEffectivelyEmptyStripsRegistry(empty)).toBe(true);
    expect(isEffectivelyEmptyStripsRegistry({
      ...empty,
      crews: [createRegistryCrew()],
    })).toBe(true);

    const namedCrew = { ...createRegistryCrew(), name: "СОКІЛ-1" };
    expect(isEffectivelyEmptyStripsRegistry({ ...empty, crews: [namedCrew] })).toBe(false);
    expect(isEffectivelyEmptyStripsRegistry({
      ...empty,
      positions: [createRegistryPosition()],
    })).toBe(false);
    expect(isEffectivelyEmptyStripsRegistry({
      ...empty,
      assignments: [createRegistryAssignment()],
    })).toBe(false);
  });

  it("provides a complete four-strip QA fixture without violating registry rules", () => {
    const data = createDemoStripsRegistry("2026-10-14");
    const report = registryToStripsReport(data);
    const operationalStrips = report.strips.filter((strip) => strip.name !== "Екіпажі без позиції");

    expect(data.positions).toHaveLength(24);
    expect(data.crews).toHaveLength(40);
    expect(data.assignments).toHaveLength(32);
    expect(operationalStrips).toHaveLength(4);
    operationalStrips.forEach((strip) => {
      expect(strip.groups.reduce((total, group) => total + group.positions.length, 0)).toBe(6);
      expect(strip.groups.reduce(
        (total, group) => total + group.positions.reduce((count, position) => count + position.crews.length, 0),
        0,
      )).toBe(8);
    });
    expect(validateStripsRegistry(data)).toEqual([]);
    expect(validateStripsReportErrors(report)).toEqual([]);
    const summary = calculateStripsSummary(report.strips);
    expect(summary.crews).toEqual([
      { uavType: "ФПВ", ready: 8, notReady: 0, forming: 0, total: 8 },
      { uavType: "ФПВ Перехоплювач", ready: 0, notReady: 3, forming: 0, total: 3 },
      { uavType: "Коптер", ready: 4, notReady: 3, forming: 0, total: 7 },
      { uavType: "Бомбер", ready: 1, notReady: 3, forming: 0, total: 4 },
      { uavType: "Літаковий Розвідувальний", ready: 5, notReady: 0, forming: 0, total: 5 },
      { uavType: "Літаковий Ударний", ready: 2, notReady: 0, forming: 0, total: 2 },
      { uavType: "НРК", ready: 0, notReady: 3, forming: 0, total: 3 },
    ]);
    expect(summary.crewTotals).toEqual({ ready: 20, notReady: 12, forming: 0, total: 32 });
    expect(summary.positions).toEqual([
      { uavType: "ФПВ", ready: 4, notReady: 0, forming: 0, total: 4 },
      { uavType: "ФПВ Перехоплювач", ready: 0, notReady: 2, forming: 0, total: 2 },
      { uavType: "Коптер", ready: 2, notReady: 2, forming: 0, total: 4 },
      { uavType: "Бомбер", ready: 1, notReady: 2, forming: 0, total: 3 },
      { uavType: "Літаковий Розвідувальний", ready: 3, notReady: 0, forming: 0, total: 3 },
      { uavType: "Літаковий Ударний", ready: 2, notReady: 0, forming: 0, total: 2 },
      { uavType: "НРК", ready: 0, notReady: 2, forming: 0, total: 2 },
    ]);
    expect(summary.positionTotals).toEqual({ ready: 12, notReady: 8, forming: 0, total: 20 });
    expect(summary.crewsByUnitAndStrip).toEqual({
      columns: ["Смуга ПІВНІЧ", "Смуга СХІД", "Смуга ПІВДЕНЬ", "Смуга ЗАХІД"],
      rows: [
        { label: "1 РУБАК", values: [3, 3, 1, 2], total: 9 },
        { label: "2 РУБАК", values: [2, 2, 0, 1], total: 5 },
        { label: "3 РУБАК", values: [2, 2, 2, 3], total: 9 },
        { label: "4 РУБАК", values: [1, 1, 2, 2], total: 6 },
        { label: "Саперний взвод", values: [0, 0, 2, 0], total: 2 },
        { label: "Рота НРК", values: [0, 0, 1, 0], total: 1 },
      ],
      columnTotals: [8, 8, 8, 8],
      total: 32,
    });
    expect(summary.crewsByUnitAndUavType).toEqual({
      columns: [
        "ФПВ",
        "ФПВ Перехоплювач",
        "Коптер",
        "Бомбер",
        "Літаковий Розвідувальний",
        "Літаковий Ударний",
        "НРК",
      ],
      rows: [
        { label: "1 РУБАК", values: [2, 0, 4, 1, 1, 1, 0], total: 9 },
        { label: "2 РУБАК", values: [2, 0, 3, 0, 0, 0, 0], total: 5 },
        { label: "3 РУБАК", values: [2, 2, 0, 2, 2, 1, 0], total: 9 },
        { label: "4 РУБАК", values: [2, 1, 0, 1, 2, 0, 0], total: 6 },
        { label: "Саперний взвод", values: [0, 0, 0, 0, 0, 0, 2], total: 2 },
        { label: "Рота НРК", values: [0, 0, 0, 0, 0, 0, 1], total: 1 },
      ],
      columnTotals: [8, 3, 7, 4, 5, 2, 3],
      total: 32,
    });
    expect(summary.crewsByStripAndUavType).toEqual({
      columns: [
        "ФПВ",
        "ФПВ Перехоплювач",
        "Коптер",
        "Бомбер",
        "Літаковий Розвідувальний",
        "Літаковий Ударний",
        "НРК",
      ],
      rows: [
        { label: "Смуга ПІВНІЧ", values: [4, 0, 0, 3, 1, 0, 0], total: 8 },
        { label: "Смуга СХІД", values: [0, 3, 4, 0, 0, 1, 0], total: 8 },
        { label: "Смуга ПІВДЕНЬ", values: [4, 0, 0, 1, 0, 0, 3], total: 8 },
        { label: "Смуга ЗАХІД", values: [0, 0, 3, 0, 4, 1, 0], total: 8 },
      ],
      columnTotals: [8, 3, 7, 4, 5, 2, 3],
      total: 32,
    });
    expect(summary.crewsByUnitAndStrip.total).toBe(summary.crewTotals.total);
    expect(summary.crewsByUnitAndUavType.total).toBe(summary.crewTotals.total);
    expect(summary.crewsByStripAndUavType.total).toBe(summary.crewTotals.total);
    expect(summary.exceptions).toEqual([
      { uavType: "ФПВ Перехоплювач", crewsWithoutPosition: 4, positionsWithoutCrews: 0 },
      { uavType: "Бомбер", crewsWithoutPosition: 0, positionsWithoutCrews: 1 },
      { uavType: "Літаковий Розвідувальний", crewsWithoutPosition: 0, positionsWithoutCrews: 1 },
      { uavType: "Літаковий Ударний", crewsWithoutPosition: 0, positionsWithoutCrews: 2 },
      { uavType: "НРК", crewsWithoutPosition: 4, positionsWithoutCrews: 0 },
    ]);
    expect(summary.crewsWithoutPosition).toBe(8);
    expect(summary.positionsWithoutCrews).toBe(4);
    expect(summary.crewTotals.total + summary.crewsWithoutPosition).toBe(data.crews.length);
    expect(summary.positionTotals.total + summary.positionsWithoutCrews).toBe(data.positions.length);

    operationalStrips.forEach((strip) => {
      const stripSummary = calculateStripsSummary([strip]);
      expect(stripSummary.crewTotals).toEqual({ ready: 5, notReady: 3, forming: 0, total: 8 });
      expect(stripSummary.positionTotals).toEqual({ ready: 3, notReady: 2, forming: 0, total: 5 });
      expect(stripSummary.crewsWithoutPosition).toBe(0);
      expect(stripSummary.positionsWithoutCrews).toBe(1);
    });

    const unassignedStrip = report.strips.find((strip) => strip.name === "Екіпажі без позиції");
    expect(unassignedStrip).toBeDefined();
    const unassignedSummary = calculateStripsSummary([unassignedStrip!]);
    expect(unassignedSummary.crewTotals).toEqual({ ready: 0, notReady: 0, forming: 0, total: 0 });
    expect(unassignedSummary.positionTotals).toEqual({ ready: 0, notReady: 0, forming: 0, total: 0 });
    expect(unassignedSummary.crewsWithoutPosition).toBe(8);
    expect(unassignedSummary.positionsWithoutCrews).toBe(0);

    const tableMarkup = renderToStaticMarkup(createElement(StripsReportView, { report, zoom: 100 }));
    operationalStrips.forEach((strip) => {
      expect(tableMarkup).toContain(`aria-label="Підсумок смуги ${strip.name}"`);
    });
    expect(tableMarkup).not.toContain("aria-label=\"Підсумок смуги Екіпажі без позиції\"");
    expect(tableMarkup).toContain("Екіпажі за підрозділами по смугах");
    expect(tableMarkup).toContain("Екіпажі за підрозділами по типах БпЛА");
    expect(tableMarkup).toContain("Екіпажі по смугах за типами БпЛА");
    expect(tableMarkup).toContain("Готовність екіпажів за підрозділами");
    expect(tableMarkup).toContain("Готовність екіпажів за смугами");
    expect(tableMarkup).toContain("Заповнення екіпажів і позицій за підрозділами");
    expect(tableMarkup).toContain("83,3%");
  });

  it("keeps position-only fields out of a crew record", () => {
    const crew = createRegistryCrew();
    expect(crew).not.toHaveProperty("strip");
    expect(crew).not.toHaveProperty("bro");
    expect(crew).not.toHaveProperty("area");
    expect(crew).not.toHaveProperty("direction");
  });

  it("builds a valid classic strips report from linked master records", () => {
    const data = validRegistry();
    const report = registryToStripsReport(data);

    expect(validateStripsRegistry(data)).toEqual([]);
    expect(validateStripsReportErrors(report)).toEqual([]);
    expect(report.strips[0].groups[0].positions[0].crews[0].name).toBe("СОКІЛ-1");
  });

  it("moves a crew by changing only its assignment", () => {
    const data = validRegistry();
    const second = {
      ...createRegistryPosition(),
      name: "ПОЗИЦІЯ БУРЯ",
      strip: "Смуга ПІВДЕНЬ",
      unit: "2 РУБАК",
      uavType: "ФПВ" as const,
      readiness: "БГ" as const,
      bro: "БРО-2",
      area: "РАЙОН ПІВДЕНЬ",
      direction: "Південний напрямок",
    };
    data.positions.push(second);
    data.assignments[0].positionId = second.id;

    const report = registryToStripsReport(data);
    const first = report.strips.find((strip) => strip.name === "Смуга ПІВНІЧ");
    const south = report.strips.find((strip) => strip.name === "Смуга ПІВДЕНЬ");
    expect(first?.groups[0].positions[0].crews).toHaveLength(0);
    expect(south?.groups[0].positions[0].crews.map((crew) => crew.name)).toEqual(["СОКІЛ-1"]);
  });

  it("takes location data from the position without mutating the crew", () => {
    const data = validRegistry();
    const crewBefore = JSON.parse(JSON.stringify(data.crews[0]));
    data.positions[0].strip = "Смуга СХІД";
    data.positions[0].bro = "БРО-НОВИЙ";
    data.positions[0].area = "СХІДНИЙ РАЙОН";
    data.positions[0].direction = "Східний напрямок";

    const report = registryToStripsReport(data);
    const exportedPosition = report.strips[0].groups[0].positions[0];
    expect(report.strips[0].name).toBe("Смуга СХІД");
    expect(exportedPosition.bro).toBe("БРО-НОВИЙ");
    expect(exportedPosition.area).toBe("СХІДНИЙ РАЙОН");
    expect(exportedPosition.direction).toBe("Східний напрямок");
    expect(data.crews[0]).toEqual(crewBefore);
  });

  it("keeps unlinked crews and empty positions separate with required notes", () => {
    const data = validRegistry();
    data.assignments = [];

    const report = registryToStripsReport(data);
    const positionGroup = report.strips.find((strip) => strip.name === "Смуга ПІВНІЧ")?.groups[0];
    const looseGroup = report.strips.find((strip) => strip.name === "Екіпажі без позиції")?.groups[0];
    expect(looseGroup?.looseCrews[0].note).toBe(CREW_WITHOUT_POSITION_NOTE);
    expect(positionGroup?.positions[0].note).toBe(POSITION_WITHOUT_CREW_NOTE);
    const summary = calculateStripsSummary(report.strips);
    expect(summary.crewTotals).toEqual({ ready: 0, notReady: 0, forming: 0, total: 0 });
    expect(summary.positionTotals).toEqual({ ready: 0, notReady: 0, forming: 0, total: 0 });
    expect(summary.crewsWithoutPosition).toBe(1);
    expect(summary.positionsWithoutCrews).toBe(1);
  });

  it("allows several crews on one position without counting the position twice", () => {
    const data = validRegistry();
    const secondCrew = {
      ...createRegistryCrew(),
      name: "СОКІЛ-2",
      unit: "1 РУБАК",
      uavType: "ФПВ" as const,
      readiness: "БГ" as const,
      duty: "Відпочинок після БЧ" as const,
    };
    data.crews.push(secondCrew);
    data.assignments.push({
      ...createRegistryAssignment(),
      crewId: secondCrew.id,
      positionId: data.positions[0].id,
    });

    const summary = calculateStripsSummary(registryToStripsReport(data).strips);
    expect(summary.crewTotals.total).toBe(2);
    expect(summary.positionTotals.total).toBe(1);
  });

  it("rejects assigning one crew more than once", () => {
    const data = validRegistry();
    data.assignments.push({
      ...createRegistryAssignment(),
      crewId: data.crews[0].id,
      positionId: data.positions[0].id,
    });
    expect(validateStripsRegistry(data).join("\n")).toContain("уже розподілений");
  });

  it("rejects links that mix different units or UAV types", () => {
    const data = validRegistry();
    data.positions[0].unit = "2 РУБАК";
    data.positions[0].uavType = "Бомбер";
    const errors = validateStripsRegistry(data).join("\n");
    expect(errors).toContain("підрозділ екіпажу має збігатися");
    expect(errors).toContain("тип БпЛА екіпажу має збігатися");
  });

  it("normalizes a saved encrypted draft without changing its links", () => {
    const data = validRegistry();
    const restored = normalizeStripsRegistry(JSON.parse(JSON.stringify(data)));
    expect(restored).toEqual(data);
  });

  it("migrates a version 1 draft without keeping the old crew strip field", () => {
    const data = validRegistry();
    const legacy = {
      ...data,
      version: 1,
      crews: data.crews.map((crew) => ({ ...crew, strip: "Застаріла смуга" })),
    };

    const restored = normalizeStripsRegistry(legacy);
    expect(restored?.version).toBe(2);
    expect(restored?.assignments).toEqual(data.assignments);
    expect(restored?.crews[0]).not.toHaveProperty("strip");
    expect(restored?.crews[0].unit).toBe(data.positions[0].unit);
    expect(restored?.crews[0].uavType).toBe(data.positions[0].uavType);
  });

  it("drops invisible incomplete, dangling and duplicate links from saved drafts", () => {
    const data = validRegistry();
    const valid = data.assignments[0];
    const legacy = {
      ...data,
      version: 1,
      assignments: [
        valid,
        { id: "blank-link", crewId: "", positionId: "" },
        { id: "missing-crew", crewId: "unknown", positionId: data.positions[0].id },
        { id: "missing-position", crewId: data.crews[0].id, positionId: "unknown" },
        { id: "second-link-for-same-crew", crewId: data.crews[0].id, positionId: data.positions[0].id },
        { id: valid.id, crewId: data.crews[0].id, positionId: data.positions[0].id },
      ],
    };

    const restored = normalizeStripsRegistry(legacy);
    expect(restored?.assignments).toEqual([valid]);
    expect(validateStripsRegistry(restored!)).toEqual([]);
  });
});
