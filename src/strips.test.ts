import { describe, expect, it } from "vitest";
import {
  applyCrewReadiness,
  applyPositionReadiness,
  attachLooseCrew,
  calculateStripsSummary,
  createCrew,
  createDemoStripsReport,
  createGroup,
  createPositionForLooseCrew,
  createStrip,
  detachCrew,
  normalizeStripsReport,
  readinessDisplay,
  setCrewReadinessInGroup,
  validateStripsReport,
  type StripsReport,
} from "./strips";

function validReport(): StripsReport {
  const strip = createStrip("Смуга АЛЬФА");
  const group = strip.groups[0];
  group.unit = "1 РУБАК";
  group.uavType = "ФПВ";
  const position = group.positions[0];
  Object.assign(position, {
    name: "Позиція 1",
    readiness: "БГ",
    bro: "БРО-1",
    area: "РАЙОН ПІВНІЧ",
    direction: "Північний",
  });
  position.crews.push({
    ...createCrew(),
    name: "Вовки",
    readiness: "БГ",
    duty: "БЧ",
  });
  return { version: 1, reportDate: "2026-10-12", strips: [strip] };
}

describe("strips report", () => {
  it("requires a reason before a not-ready status can be applied", () => {
    const report = validReport();
    const position = report.strips[0].groups[0].positions[0];
    const unchanged = applyPositionReadiness(position, "Не БГ");
    expect(unchanged).toBe(position);

    position.readiness = "Не БГ";
    expect(validateStripsReport(report)).toContain("причину");
    position.notReadyReason = "Зміна позиції";
    position.crews[0] = applyCrewReadiness(position.crews[0], "Не БГ", "Зміна позиції");
    expect(validateStripsReport(report)).toBe("");
    expect(readinessDisplay("Не БГ", "Зміна позиції")).toBe("Не БГ (Зміна позиції)");
  });

  it("allows forming duty only for forming crews", () => {
    const crew = { ...createCrew(), duty: "БЧ" as const };
    const forming = applyCrewReadiness(crew, "Формується");
    expect(forming.duty).toBe("Формується");
    const ready = applyCrewReadiness(forming, "БГ");
    expect(ready.duty).toBe("");

    const report = validReport();
    report.strips[0].groups[0].positions[0].crews[0].duty = "Формується";
    expect(validateStripsReport(report)).toContain("БЧ або");
  });

  it("counts several crews on one position without duplicating that position", () => {
    const report = validReport();
    const position = report.strips[0].groups[0].positions[0];
    position.crews.push({
      ...createCrew(),
      name: "Соколи",
      readiness: "БГ",
      duty: "Відпочинок після БЧ",
    });

    const summary = calculateStripsSummary(report.strips);
    expect(summary.positionTotals).toEqual({ ready: 1, notReady: 0, forming: 0, total: 1 });
    expect(summary.crewTotals).toEqual({ ready: 2, notReady: 0, forming: 0, total: 2 });
  });

  it("counts every crew once and reports records without links separately", () => {
    const report = validReport();
    const strip = report.strips[0];
    const bomberGroup = createGroup();
    bomberGroup.unit = "2 РУБАК";
    bomberGroup.uavType = "Бомбер";
    const noCrew = bomberGroup.positions[0];
    Object.assign(noCrew, {
      name: "Резервна позиція",
      readiness: "Не БГ",
      notReadyReason: "Немає екіпажу",
      bro: "БРО-2",
      area: "РАЙОН СХІД",
      direction: "Східний",
      crews: [],
    });
    strip.groups.push(bomberGroup);

    const secondStrip = createStrip("Смуга БРАВО");
    const copterGroup = secondStrip.groups[0];
    copterGroup.unit = "3 РУБАК";
    copterGroup.uavType = "Коптер";
    copterGroup.positions = [];
    copterGroup.looseCrews.push({
      ...createCrew(),
      name: "Буревій",
      readiness: "Формується",
      duty: "Формується",
    });
    report.strips.push(secondStrip);

    const summary = calculateStripsSummary(report.strips);
    expect(summary.positionTotals.total).toBe(1);
    expect(summary.crewTotals).toEqual({ ready: 1, notReady: 0, forming: 1, total: 2 });
    expect(summary.positionsWithoutCrews).toBe(1);
    expect(summary.crewsWithoutPosition).toBe(1);
    expect(summary.exceptions).toEqual([
      { uavType: "Коптер", crewsWithoutPosition: 1, positionsWithoutCrews: 0 },
      { uavType: "Бомбер", crewsWithoutPosition: 0, positionsWithoutCrews: 1 },
    ]);
    expect(summary.positions.some((row) => row.uavType === "Бомбер")).toBe(false);
    expect(summary.crews.some((row) => row.uavType === "Коптер")).toBe(true);
  });

  it("detaches an incompatible crew atomically and still counts it as not ready", () => {
    const report = validReport();
    const group = report.strips[0].groups[0];
    const position = group.positions[0];
    const second = { ...createCrew(), name: "Соколи", readiness: "БГ" as const, duty: "БЧ" as const };
    position.crews.push(second);

    const changed = setCrewReadinessInGroup(group, position.id, second.id, "Не БГ", "Виведено з позиції");
    expect(changed.positions[0].crews.map((crew) => crew.id)).toEqual([position.crews[0].id]);
    expect(changed.looseCrews.map((crew) => crew.id)).toEqual([second.id]);
    const summary = calculateStripsSummary([{ ...report.strips[0], groups: [changed] }]);
    expect(summary.positionTotals).toEqual({ ready: 1, notReady: 0, forming: 0, total: 1 });
    expect(summary.crewTotals).toEqual({ ready: 1, notReady: 1, forming: 0, total: 2 });
    expect(summary.crewsWithoutPosition).toBe(1);
  });

  it("moves crews between a position and the unlinked list without copying ids", () => {
    const report = validReport();
    const group = report.strips[0].groups[0];
    const position = group.positions[0];
    const crew = position.crews[0];
    const detached = detachCrew(group, position.id, crew.id);
    expect(detached.positions[0].crews).toHaveLength(0);
    expect(detached.looseCrews.map((item) => item.id)).toEqual([crew.id]);

    const attached = attachLooseCrew(detached, position.id, crew.id);
    expect(attached.positions[0].crews.map((item) => item.id)).toEqual([crew.id]);
    expect(attached.looseCrews).toHaveLength(0);
    expect(attachLooseCrew(attached, position.id, crew.id)).toBe(attached);
  });

  it("creates a position for an existing crew and blocks that action for forming crews", () => {
    const group = createGroup();
    group.positions = [];
    const ready = { ...createCrew(), name: "Варта", readiness: "БГ" as const, duty: "БЧ" as const };
    group.looseCrews = [ready];
    const linked = createPositionForLooseCrew(group, ready.id);
    expect(linked.positions).toHaveLength(1);
    expect(linked.positions[0].crews[0].id).toBe(ready.id);
    expect(linked.looseCrews).toHaveLength(0);

    const forming = { ...createCrew(), name: "Резерв", readiness: "Формується" as const, duty: "Формується" as const };
    const formingGroup = { ...group, looseCrews: [forming] };
    expect(createPositionForLooseCrew(formingGroup, forming.id)).toBe(formingGroup);
  });

  it("rejects duplicate ids and never double-counts them", () => {
    const report = validReport();
    const position = report.strips[0].groups[0].positions[0];
    position.crews.push(position.crews[0]);
    expect(validateStripsReport(report)).toContain("повторений блок");
    expect(calculateStripsSummary(report.strips).crewTotals.total).toBe(1);
  });

  it("normalizes restored data and rejects impossible dates", () => {
    const report = validReport();
    report.strips[0].groups[0].positions[0].area = "північний район";
    const restored = normalizeStripsReport(JSON.parse(JSON.stringify(report)));
    expect(restored?.strips[0].groups[0].positions[0].area).toBe("ПІВНІЧНИЙ РАЙОН");

    report.reportDate = "2026-02-30";
    expect(validateStripsReport(report)).toContain("правильну дату");
  });

  it("migrates old mixed links into separate crew records", () => {
    const report = validReport();
    const position = report.strips[0].groups[0].positions[0];
    const oldMixed = {
      ...createCrew(),
      name: "Старий запис",
      readiness: "Не БГ" as const,
      notReadyReason: "Ремонт",
      duty: "БЧ" as const,
    };
    position.crews.push(oldMixed);
    const restored = normalizeStripsReport(JSON.parse(JSON.stringify(report)));
    expect(restored?.strips[0].groups[0].positions[0].crews.map((crew) => crew.id)).not.toContain(oldMixed.id);
    expect(restored?.strips[0].groups[0].looseCrews.map((crew) => crew.id)).toContain(oldMixed.id);
  });

  it("rejects impossible linked statuses before export", () => {
    const report = validReport();
    report.strips[0].groups[0].positions[0].crews[0].readiness = "Формується";
    report.strips[0].groups[0].positions[0].crews[0].duty = "Формується";
    expect(validateStripsReport(report)).toContain("не може бути закріплений");
  });

  it("creates a complete demo with linked and unlinked examples", () => {
    const report = createDemoStripsReport("2026-10-12");
    expect(validateStripsReport(report)).toBe("");

    const summary = calculateStripsSummary(report.strips);
    expect(report.strips).toHaveLength(3);
    expect(summary.crewTotals).toEqual({ ready: 5, notReady: 1, forming: 1, total: 7 });
    expect(summary.positionTotals).toEqual({ ready: 2, notReady: 1, forming: 0, total: 3 });
    expect(summary.crewsWithoutPosition).toBe(2);
    expect(summary.positionsWithoutCrews).toBe(1);
  });
});
