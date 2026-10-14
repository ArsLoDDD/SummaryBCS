import { describe, expect, it } from "vitest";
import {
  calculateStripsSummary,
  createCrew,
  createGroup,
  createPosition,
  createStrip,
} from "./strips";
import {
  createDemoStripsRegistry,
  registryToStripsReport,
} from "./stripsRegistry";
import { calculateStripsOperationalStats } from "./stripsOperationalStats";

describe("strips operational statistics", () => {
  it("reconciles readiness and link coverage for the complete Registry fixture", () => {
    const registry = createDemoStripsRegistry("2026-10-14");
    const report = registryToStripsReport(registry);
    const mainSummary = calculateStripsSummary(report.strips);
    const stats = calculateStripsOperationalStats(report.strips);

    expect(stats.readinessByUnit).toEqual([
      { label: "1 РУБАК", ready: 7, notReady: 2, forming: 0, total: 9, readyRatePercent: 77.8 },
      { label: "2 РУБАК", ready: 4, notReady: 1, forming: 0, total: 5, readyRatePercent: 80 },
      { label: "3 РУБАК", ready: 5, notReady: 4, forming: 0, total: 9, readyRatePercent: 55.6 },
      { label: "4 РУБАК", ready: 4, notReady: 2, forming: 0, total: 6, readyRatePercent: 66.7 },
      { label: "Саперний взвод", ready: 0, notReady: 2, forming: 0, total: 2, readyRatePercent: 0 },
      { label: "Рота НРК", ready: 0, notReady: 1, forming: 0, total: 1, readyRatePercent: 0 },
    ]);
    expect(stats.readinessByStrip).toEqual([
      { label: "Смуга ПІВНІЧ", ready: 5, notReady: 3, forming: 0, total: 8, readyRatePercent: 62.5 },
      { label: "Смуга СХІД", ready: 5, notReady: 3, forming: 0, total: 8, readyRatePercent: 62.5 },
      { label: "Смуга ПІВДЕНЬ", ready: 5, notReady: 3, forming: 0, total: 8, readyRatePercent: 62.5 },
      { label: "Смуга ЗАХІД", ready: 5, notReady: 3, forming: 0, total: 8, readyRatePercent: 62.5 },
    ]);
    expect(stats.coverageByUnit).toEqual([
      {
        label: "1 РУБАК",
        crewsTotal: 11, crewsLinked: 9, crewsUnlinked: 2, crewLinkRatePercent: 81.8,
        positionsTotal: 6, positionsOccupied: 6, positionsEmpty: 0, positionStaffingRatePercent: 100,
      },
      {
        label: "2 РУБАК",
        crewsTotal: 7, crewsLinked: 5, crewsUnlinked: 2, crewLinkRatePercent: 71.4,
        positionsTotal: 6, positionsOccupied: 3, positionsEmpty: 3, positionStaffingRatePercent: 50,
      },
      {
        label: "3 РУБАК",
        crewsTotal: 11, crewsLinked: 9, crewsUnlinked: 2, crewLinkRatePercent: 81.8,
        positionsTotal: 5, positionsOccupied: 5, positionsEmpty: 0, positionStaffingRatePercent: 100,
      },
      {
        label: "4 РУБАК",
        crewsTotal: 7, crewsLinked: 6, crewsUnlinked: 1, crewLinkRatePercent: 85.7,
        positionsTotal: 5, positionsOccupied: 4, positionsEmpty: 1, positionStaffingRatePercent: 80,
      },
      {
        label: "Саперний взвод",
        crewsTotal: 3, crewsLinked: 2, crewsUnlinked: 1, crewLinkRatePercent: 66.7,
        positionsTotal: 1, positionsOccupied: 1, positionsEmpty: 0, positionStaffingRatePercent: 100,
      },
      {
        label: "Рота НРК",
        crewsTotal: 1, crewsLinked: 1, crewsUnlinked: 0, crewLinkRatePercent: 100,
        positionsTotal: 1, positionsOccupied: 1, positionsEmpty: 0, positionStaffingRatePercent: 100,
      },
    ]);
    expect(stats.coverageOverall).toEqual({
      crewsTotal: 40,
      crewsLinked: 32,
      crewsUnlinked: 8,
      crewLinkRatePercent: 80,
      positionsTotal: 24,
      positionsOccupied: 20,
      positionsEmpty: 4,
      positionStaffingRatePercent: 83.3,
    });

    const unitReadinessTotal = stats.readinessByUnit.reduce((sum, row) => sum + row.total, 0);
    const stripReadinessTotal = stats.readinessByStrip.reduce((sum, row) => sum + row.total, 0);
    expect(unitReadinessTotal).toBe(mainSummary.crewTotals.total);
    expect(stripReadinessTotal).toBe(mainSummary.crewTotals.total);
    expect(stats.coverageOverall.crewsLinked).toBe(mainSummary.crewTotals.total);
    expect(stats.coverageOverall.crewsUnlinked).toBe(mainSummary.crewsWithoutPosition);
    expect(stats.coverageOverall.positionsOccupied).toBe(mainSummary.positionTotals.total);
    expect(stats.coverageOverall.positionsEmpty).toBe(mainSummary.positionsWithoutCrews);
    expect(stats.coverageOverall.crewsTotal).toBe(registry.crews.length);
    expect(stats.coverageOverall.positionsTotal).toBe(registry.positions.length);
  });

  it("deduplicates repeated crews, gives a linked record priority and merges normalized labels", () => {
    const looseStrip = createStrip("Смуга АЛЬФА");
    const looseGroup = looseStrip.groups[0];
    looseGroup.unit = " 1  РУБАК ";
    looseGroup.uavType = "ФПВ";
    looseGroup.positions = [];
    looseGroup.looseCrews = [{
      ...createCrew(),
      id: "loose-id",
      name: " Сокіл ",
      readiness: "БГ",
      duty: "БЧ",
    }];

    const linkedStrip = createStrip("смуга альфа");
    const linkedGroup = linkedStrip.groups[0];
    linkedGroup.unit = "1 рубак";
    linkedGroup.uavType = "ФПВ";
    linkedGroup.positions = [createPosition([{
      ...createCrew(),
      id: "linked-id",
      name: "СОКІЛ",
      readiness: "Не БГ",
      notReadyReason: "Ремонт",
      duty: "БЧ",
    }])];
    Object.assign(linkedGroup.positions[0], {
      id: "position-1",
      name: "Позиція 1",
      readiness: "Не БГ",
    });

    const stats = calculateStripsOperationalStats([looseStrip, linkedStrip]);
    expect(stats.readinessByUnit).toEqual([{
      label: "1 РУБАК",
      ready: 0,
      notReady: 1,
      forming: 0,
      total: 1,
      readyRatePercent: 0,
    }]);
    expect(stats.readinessByStrip).toEqual([{
      label: "Смуга АЛЬФА",
      ready: 0,
      notReady: 1,
      forming: 0,
      total: 1,
      readyRatePercent: 0,
    }]);
    expect(stats.coverageOverall).toEqual({
      crewsTotal: 1,
      crewsLinked: 1,
      crewsUnlinked: 0,
      crewLinkRatePercent: 100,
      positionsTotal: 1,
      positionsOccupied: 1,
      positionsEmpty: 0,
      positionStaffingRatePercent: 100,
    });
  });

  it("keeps unlinked crews and empty positions out of operational readiness", () => {
    const strip = createStrip("Смуга ПІВНІЧ");
    const group = createGroup();
    group.unit = "1 РУБАК";
    group.uavType = "ФПВ";
    group.positions = [createPosition()];
    Object.assign(group.positions[0], {
      id: "empty-position",
      name: "Резервна позиція",
      readiness: "БГ",
    });
    group.looseCrews = [{
      ...createCrew(),
      id: "unlinked-crew",
      name: "Резерв",
      readiness: "Формується",
      duty: "Формується",
    }];
    strip.groups = [group];

    const stats = calculateStripsOperationalStats([strip]);
    expect(stats.readinessByUnit).toEqual([]);
    expect(stats.readinessByStrip).toEqual([]);
    expect(stats.coverageByUnit).toEqual([{
      label: "1 РУБАК",
      crewsTotal: 1,
      crewsLinked: 0,
      crewsUnlinked: 1,
      crewLinkRatePercent: 0,
      positionsTotal: 1,
      positionsOccupied: 0,
      positionsEmpty: 1,
      positionStaffingRatePercent: 0,
    }]);
  });
});
