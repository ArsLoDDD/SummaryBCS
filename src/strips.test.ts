import { describe, expect, it } from "vitest";
import {
  CREW_WITHOUT_POSITION_NOTE,
  POSITION_WITHOUT_CREW_NOTE,
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
  validateStripsReportErrors,
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

  it("combines several units of the same UAV type into one summary row", () => {
    const report = validReport();
    const secondUnit = createGroup();
    secondUnit.unit = "2 РУБАК";
    secondUnit.uavType = "ФПВ";
    Object.assign(secondUnit.positions[0], {
      name: "Позиція 2",
      readiness: "БГ",
      bro: "БРО-2",
      area: "РАЙОН ПІВДЕНЬ",
      direction: "Південний",
      crews: [{ ...createCrew(), name: "Соколи", readiness: "БГ", duty: "БЧ" }],
    });
    report.strips[0].groups.push(secondUnit);

    const summary = calculateStripsSummary(report.strips);
    expect(summary.crews).toEqual([
      { uavType: "ФПВ", ready: 2, notReady: 0, forming: 0, total: 2 },
    ]);
    expect(summary.positions).toEqual([
      { uavType: "ФПВ", ready: 2, notReady: 0, forming: 0, total: 2 },
    ]);
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
    expect(summary.crewTotals).toEqual({ ready: 1, notReady: 0, forming: 0, total: 1 });
    expect(summary.positionsWithoutCrews).toBe(1);
    expect(summary.crewsWithoutPosition).toBe(1);
    expect(summary.exceptions).toEqual([
      { uavType: "Коптер", crewsWithoutPosition: 1, positionsWithoutCrews: 0 },
      { uavType: "Бомбер", crewsWithoutPosition: 0, positionsWithoutCrews: 1 },
    ]);
    expect(summary.positions.some((row) => row.uavType === "Бомбер")).toBe(false);
    expect(summary.crews.some((row) => row.uavType === "Коптер")).toBe(false);
  });

  it("detaches an incompatible crew atomically and reports it outside the main summary", () => {
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
    expect(summary.crewTotals).toEqual({ ready: 1, notReady: 0, forming: 0, total: 1 });
    expect(summary.crewsWithoutPosition).toBe(1);
  });

  it("moves crews between a position and the unlinked list without copying ids", () => {
    const report = validReport();
    const group = report.strips[0].groups[0];
    const position = group.positions[0];
    const crew = position.crews[0];
    position.note = "Примітка позиції";
    crew.note = "Примітка екіпажу";
    const detached = detachCrew(group, position.id, crew.id);
    expect(detached.positions[0].crews).toHaveLength(0);
    expect(detached.looseCrews.map((item) => item.id)).toEqual([crew.id]);
    expect(detached.positions[0].note).toBe(`${POSITION_WITHOUT_CREW_NOTE}\nПримітка позиції`);
    expect(detached.looseCrews[0].note).toBe(`${CREW_WITHOUT_POSITION_NOTE}\nПримітка екіпажу`);

    const attached = attachLooseCrew(detached, position.id, crew.id);
    expect(attached.positions[0].crews.map((item) => item.id)).toEqual([crew.id]);
    expect(attached.looseCrews).toHaveLength(0);
    expect(attached.positions[0].note).toBe("Примітка позиції");
    expect(attached.positions[0].crews[0].note).toBe("Примітка екіпажу");
    expect(attachLooseCrew(attached, position.id, crew.id)).toBe(attached);
  });

  it("adds the required notes to ready unlinked records", () => {
    const report = validReport();
    const group = report.strips[0].groups[0];
    const position = group.positions[0];
    position.crews = [];
    const updated = applyPositionReadiness(position, "БГ");
    expect(updated.note).toBe(POSITION_WITHOUT_CREW_NOTE);

    const loose = { ...createCrew(), name: "Варта", duty: "БЧ" as const };
    group.looseCrews = [loose];
    const readyGroup = setCrewReadinessInGroup(group, null, loose.id, "БГ");
    expect(readyGroup.looseCrews[0].note).toBe(CREW_WITHOUT_POSITION_NOTE);
  });

  it("allows one consecutive type block with unique units and rejects repeated type blocks or units", () => {
    const report = validReport();
    const makeLooseGroup = (unit: string, uavType: "ФПВ" | "Бомбер", crewName: string) => {
      const group = createGroup();
      group.unit = unit;
      group.uavType = uavType;
      group.positions = [];
      group.looseCrews = [{
        ...createCrew(),
        name: crewName,
        readiness: "БГ",
        duty: "БЧ",
      }];
      return group;
    };

    report.strips[0].groups.push(makeLooseGroup("2 РУБАК", "ФПВ", "Сокіл"));
    expect(validateStripsReport(report)).toBe("");

    report.strips[0].groups.push(makeLooseGroup("3 РУБАК", "Бомбер", "Грім"));
    report.strips[0].groups.push(makeLooseGroup("4 РУБАК", "ФПВ", "Варта"));
    expect(validateStripsReport(report)).toContain("тип БпЛА «ФПВ» уже доданий");

    const duplicateUnitReport = validReport();
    duplicateUnitReport.strips[0].groups.push(makeLooseGroup(" 1   рубак ", "ФПВ", "Буря"));
    expect(validateStripsReport(duplicateUnitReport)).toContain("підрозділ «1   рубак» уже доданий");
  });

  it("rejects a repeated crew name globally and never counts it twice", () => {
    const report = validReport();
    const secondStrip = createStrip("Смуга БРАВО");
    const secondGroup = secondStrip.groups[0];
    secondGroup.unit = "2 РУБАК";
    secondGroup.uavType = "Бомбер";
    Object.assign(secondGroup.positions[0], {
      name: "Позиція 2",
      readiness: "БГ",
      bro: "БРО-2",
      area: "РАЙОН ПІВДЕНЬ",
      direction: "Південний",
      crews: [{ ...createCrew(), name: "  ВОВКИ ", readiness: "БГ", duty: "БЧ" }],
    });
    report.strips.push(secondStrip);

    expect(validateStripsReport(report)).toContain("Екіпаж може бути лише в одному місці");
    const summary = calculateStripsSummary(report.strips);
    expect(summary.crewTotals.total).toBe(1);
    expect(summary.crewsByUnitAndStrip.total).toBe(1);
    expect(summary.crewsByUnitAndUavType.total).toBe(1);
    expect(summary.crewsByStripAndUavType.total).toBe(1);
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

  it("returns every validation error at once", () => {
    const report = validReport();
    const group = report.strips[0].groups[0];
    const position = group.positions[0];
    const crew = position.crews[0];
    report.strips[0].name = "";
    group.unit = "";
    group.uavType = "";
    position.name = "";
    position.readiness = "";
    position.bro = "";
    position.area = "";
    position.direction = "";
    crew.name = "";
    crew.readiness = "";
    crew.duty = "";

    const problems = validateStripsReportErrors(report);
    expect(problems).toHaveLength(11);
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("вкажіть назву"),
      expect.stringContaining("вкажіть підрозділ"),
      expect.stringContaining("оберіть тип БпЛА"),
      expect.stringContaining("вкажіть назву позиції"),
      expect.stringContaining("оберіть БГ позиції"),
      expect.stringContaining("вкажіть БРО"),
      expect.stringContaining("вкажіть район"),
      expect.stringContaining("вкажіть напрямок роботи"),
      expect.stringContaining("вкажіть назву екіпажу"),
      expect.stringContaining("оберіть БГ екіпажу"),
      expect.stringContaining("оберіть БЧ"),
    ]));
    expect(validateStripsReport(report).split("\n")).toEqual(problems);
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
    expect(summary.crewTotals).toEqual({ ready: 4, notReady: 1, forming: 0, total: 5 });
    expect(summary.positionTotals).toEqual({ ready: 2, notReady: 1, forming: 0, total: 3 });
    expect(summary.crewsWithoutPosition).toBe(2);
    expect(summary.positionsWithoutCrews).toBe(1);
    expect(report.strips[1].groups[1].positions[0].note).toContain(POSITION_WITHOUT_CREW_NOTE);
    expect(report.strips[2].groups[0].looseCrews[0].note).toContain(CREW_WITHOUT_POSITION_NOTE);
  });
});
