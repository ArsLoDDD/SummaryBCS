import { describe, expect, it } from "vitest";
import {
  CREW_WITHOUT_POSITION_NOTE,
  POSITION_WITHOUT_CREW_NOTE,
  calculateStripsSummary,
  validateStripsReportErrors,
} from "./strips";
import {
  createEmptyStripsRegistry,
  createRegistryAssignment,
  createRegistryCrew,
  createRegistryPosition,
  normalizeStripsRegistry,
  registryToStripsReport,
  validateStripsRegistry,
  type StripsRegistryData,
} from "./stripsRegistry";

function validRegistry(): StripsRegistryData {
  const crew = {
    ...createRegistryCrew(),
    name: "СОКІЛ-1",
    strip: "Смуга ПІВНІЧ",
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

  it("keeps unlinked crews and empty positions separate with required notes", () => {
    const data = validRegistry();
    data.assignments = [];

    const report = registryToStripsReport(data);
    const group = report.strips[0].groups[0];
    expect(group.looseCrews[0].note).toBe(CREW_WITHOUT_POSITION_NOTE);
    expect(group.positions[0].note).toBe(POSITION_WITHOUT_CREW_NOTE);
    const summary = calculateStripsSummary(report.strips);
    expect(summary.crewsWithoutPosition).toBe(1);
    expect(summary.positionsWithoutCrews).toBe(1);
  });

  it("allows several crews on one position without counting the position twice", () => {
    const data = validRegistry();
    const secondCrew = {
      ...createRegistryCrew(),
      name: "СОКІЛ-2",
      strip: "Смуга ПІВНІЧ",
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

  it("normalizes a saved encrypted draft without changing its links", () => {
    const data = validRegistry();
    const restored = normalizeStripsRegistry(JSON.parse(JSON.stringify(data)));
    expect(restored).toEqual(data);
  });
});
