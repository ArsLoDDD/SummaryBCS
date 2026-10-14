import { UAV_TYPES } from "./structure";

export const POSITION_READINESS = ["БГ", "Не БГ"] as const;
export const CREW_READINESS = ["БГ", "Не БГ", "Формується"] as const;
export const CREW_DUTIES = ["БЧ", "Відпочинок після БЧ"] as const;
export const POSITION_WITHOUT_CREW_NOTE = "Позиція готова до роботи, відсутній екіпаж";
export const CREW_WITHOUT_POSITION_NOTE = "Екіпаж готовий до виконання задач, відсутня позиція";

export type PositionReadiness = typeof POSITION_READINESS[number];
export type CrewReadiness = typeof CREW_READINESS[number];
export type CrewDuty = typeof CREW_DUTIES[number] | "Формується";
export type UavType = typeof UAV_TYPES[number];

export interface StripCrew {
  id: string;
  name: string;
  readiness: CrewReadiness | "";
  notReadyReason: string;
  duty: CrewDuty | "";
  assets: string;
  note: string;
}

export interface StripPosition {
  id: string;
  name: string;
  readiness: PositionReadiness | "";
  notReadyReason: string;
  bro: string;
  area: string;
  direction: string;
  note: string;
  crews: StripCrew[];
}

export interface StripGroup {
  id: string;
  unit: string;
  uavType: UavType | "";
  positions: StripPosition[];
  looseCrews: StripCrew[];
}

export interface WorkStrip {
  id: string;
  name: string;
  groups: StripGroup[];
}

export interface StripsReport {
  version: 1;
  reportDate: string;
  strips: WorkStrip[];
}

export interface StatusCounts {
  ready: number;
  notReady: number;
  forming: number;
  total: number;
}

export interface UavSummaryRow extends StatusCounts {
  uavType: UavType;
}

export interface ExceptionSummaryRow {
  uavType: UavType;
  crewsWithoutPosition: number;
  positionsWithoutCrews: number;
}

export interface CountMatrixRow {
  label: string;
  values: number[];
  total: number;
}

export interface CountMatrix {
  columns: string[];
  rows: CountMatrixRow[];
  columnTotals: number[];
  total: number;
}

export interface StripsSummary {
  crews: UavSummaryRow[];
  positions: UavSummaryRow[];
  crewTotals: StatusCounts;
  positionTotals: StatusCounts;
  exceptions: ExceptionSummaryRow[];
  crewsWithoutPosition: number;
  positionsWithoutCrews: number;
  crewsByUnitAndStrip: CountMatrix;
  crewsByUnitAndUavType: CountMatrix;
  crewsByStripAndUavType: CountMatrix;
}

let nextId = 1;

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${nextId++}`;
}

export function createCrew(prefix = "crew"): StripCrew {
  return {
    id: id(prefix),
    name: "",
    readiness: "",
    notReadyReason: "",
    duty: "",
    assets: "",
    note: "",
  };
}

export function createPosition(crews: StripCrew[] = []): StripPosition {
  return {
    id: id("position"),
    name: "",
    readiness: "",
    notReadyReason: "",
    bro: "",
    area: "",
    direction: "",
    note: "",
    crews,
  };
}

export function createGroup(): StripGroup {
  return {
    id: id("group"),
    unit: "",
    uavType: "",
    positions: [createPosition()],
    looseCrews: [],
  };
}

export function createStrip(name = "Смуга 1"): WorkStrip {
  return {
    id: id("strip"),
    name,
    groups: [createGroup()],
  };
}

export function createDemoStripsReport(reportDate: string): StripsReport {
  const crew = (
    name: string,
    readiness: CrewReadiness,
    duty: CrewDuty,
    assets: string,
    notReadyReason = "",
    note = "",
  ): StripCrew => ({
    ...createCrew(),
    name,
    readiness,
    notReadyReason,
    duty,
    assets,
    note,
  });
  const position = (
    name: string,
    readiness: PositionReadiness,
    bro: string,
    area: string,
    direction: string,
    crews: StripCrew[],
    notReadyReason = "",
    note = "",
  ): StripPosition => syncPositionSystemNote({
    ...createPosition(),
    name,
    readiness,
    notReadyReason,
    bro,
    area: upperUk(area),
    direction,
    note,
    crews,
  });
  const group = (
    unit: string,
    uavType: UavType,
    positions: StripPosition[],
    looseCrews: StripCrew[] = [],
  ): StripGroup => ({
    ...createGroup(),
    unit,
    uavType,
    positions,
    looseCrews: looseCrews.map((value) => syncCrewSystemNote(value, true)),
  });
  const strip = (name: string, groups: StripGroup[]): WorkStrip => ({ ...createStrip(name), groups });

  return {
    version: 1,
    reportDate,
    strips: [
      strip("Смуга ПІВНІЧ", [
        group("1 РУБАК", "Літаковий Розвідувальний", [
          position(
            "ПОЗИЦІЯ СОКІЛ",
            "БГ",
            "БРО-1",
            "Північний район",
            "Північний напрямок",
            [
              crew("СОКІЛ-1", "БГ", "БЧ", "Лелека-100, Mavic 3T"),
              crew(
                "СОКІЛ-2",
                "БГ",
                "Відпочинок після БЧ",
                "Лелека-100",
              ),
            ],
            "",
            "Основна розвідувальна позиція",
          ),
        ]),
        group("2 РУБАК", "Бомбер", [
          position(
            "ПОЗИЦІЯ ГРІМ",
            "Не БГ",
            "БРО-2",
            "Північно-східний район",
            "Північно-східний напрямок",
            [crew("ГРІМ-1", "Не БГ", "Відпочинок після БЧ", "Vampire", "Очікується ремонт засобу")],
            "Очікується ремонт засобу",
          ),
        ], [crew("ГРІМ-2", "Формується", "Формується", "Vampire")]),
      ]),
      strip("Смуга ЦЕНТР", [
        group("3 РУБАК", "ФПВ", [
          position(
            "ПОЗИЦІЯ БУРЯ",
            "БГ",
            "БРО-3",
            "Центральний район",
            "Центральний напрямок",
            [
              crew("БУРЯ-1", "БГ", "БЧ", "FPV 10, FPV 13"),
              crew(
                "БУРЯ-2",
                "БГ",
                "Відпочинок після БЧ",
                "FPV 10",
              ),
            ],
          ),
        ]),
        group("Саперний взвод", "НРК", [
          position(
            "ПОЗИЦІЯ ІНЖЕНЕР",
            "БГ",
            "БРО-4",
            "Центральний район",
            "Інженерний напрямок",
            [],
            "",
            "Позиція без закріпленого екіпажу",
          ),
        ]),
      ]),
      strip("Смуга ПІВДЕНЬ", [
        group(
          "4 РУБАК",
          "ФПВ Перехоплювач",
          [],
          [
            crew(
              "ВАРТА-1",
              "БГ",
              "БЧ",
              "FPV-перехоплювач",
              "",
              "Очікує визначення позиції",
            ),
          ],
        ),
      ]),
    ],
  };
}

export function upperUk(value: string): string {
  return value.toLocaleUpperCase("uk-UA");
}

export function readinessDisplay(status: string, reason: string): string {
  if (status !== "Не БГ") return status;
  const normalizedReason = reason.trim();
  return normalizedReason ? `Не БГ (${normalizedReason})` : "Не БГ";
}

function toggleSystemNote(note: string, systemNote: string, required: boolean): string {
  const userNote = note
    .split(/\r?\n/)
    .filter((line) => line.trim() !== systemNote)
    .join("\n")
    .trim();
  return required ? [systemNote, userNote].filter(Boolean).join("\n") : userNote;
}

export function syncPositionSystemNote(position: StripPosition): StripPosition {
  return {
    ...position,
    note: toggleSystemNote(
      position.note,
      POSITION_WITHOUT_CREW_NOTE,
      position.readiness === "БГ" && position.crews.length === 0,
    ),
  };
}

export function syncCrewSystemNote(crew: StripCrew, withoutPosition: boolean): StripCrew {
  return {
    ...crew,
    note: toggleSystemNote(
      crew.note,
      CREW_WITHOUT_POSITION_NOTE,
      withoutPosition && crew.readiness === "БГ",
    ),
  };
}

export function applyCrewReadiness(crew: StripCrew, readiness: CrewReadiness, reason = ""): StripCrew {
  if (readiness === "Не БГ" && !reason.trim()) return crew;
  if (readiness === "Формується") {
    return { ...crew, readiness, notReadyReason: "", duty: "Формується" };
  }
  return {
    ...crew,
    readiness,
    notReadyReason: readiness === "Не БГ" ? reason.trim() : "",
    duty: crew.duty === "Формується" ? "" : crew.duty,
  };
}

export function applyPositionReadiness(
  position: StripPosition,
  readiness: PositionReadiness,
  reason = "",
): StripPosition {
  if (readiness === "Не БГ" && !reason.trim()) return position;
  return syncPositionSystemNote({
    ...position,
    readiness,
    notReadyReason: readiness === "Не БГ" ? reason.trim() : "",
  });
}

export function createCrewForPosition(position: StripPosition): StripCrew {
  const crew = createCrew();
  if (!position.readiness) return crew;
  return applyCrewReadiness(crew, position.readiness, position.notReadyReason);
}

export function detachCrew(
  group: StripGroup,
  positionId: string,
  crewId: string,
): StripGroup {
  const position = group.positions.find((item) => item.id === positionId);
  const crew = position?.crews.find((item) => item.id === crewId);
  if (!position || !crew || group.looseCrews.some((item) => item.id === crewId)) return group;
  return {
    ...group,
    positions: group.positions.map((item) => item.id === positionId
      ? syncPositionSystemNote({
          ...item,
          crews: item.crews.filter((candidate) => candidate.id !== crewId),
        })
      : item),
    looseCrews: [...group.looseCrews, syncCrewSystemNote(crew, true)],
  };
}

export function attachmentProblem(position: StripPosition, crew: StripCrew): string {
  if (crew.readiness === "Формується") {
    return "Екіпаж зі статусом «Формується» не може мати позицію.";
  }
  if (position.crews.some((item) => item.id === crew.id)) {
    return "Цей екіпаж уже закріплений за позицією.";
  }
  if (position.readiness && crew.readiness && position.readiness !== crew.readiness) {
    return "Статус екіпажу не збігається зі статусом позиції.";
  }
  return "";
}

export function attachLooseCrew(
  group: StripGroup,
  positionId: string,
  crewId: string,
): StripGroup {
  const position = group.positions.find((item) => item.id === positionId);
  const crew = group.looseCrews.find((item) => item.id === crewId);
  if (!position || !crew || attachmentProblem(position, crew)) return group;

  let nextPosition = position;
  let nextCrew = syncCrewSystemNote(crew, false);
  if (!nextPosition.readiness && nextCrew.readiness) {
    nextPosition = applyPositionReadiness(
      nextPosition,
      nextCrew.readiness as PositionReadiness,
      nextCrew.notReadyReason,
    );
  } else if (nextPosition.readiness && !nextCrew.readiness) {
    nextCrew = applyCrewReadiness(
      nextCrew,
      nextPosition.readiness,
      nextPosition.notReadyReason,
    );
  }

  return {
    ...group,
    positions: group.positions.map((item) => item.id === positionId
      ? syncPositionSystemNote({ ...nextPosition, crews: [...nextPosition.crews, nextCrew] })
      : item),
    looseCrews: group.looseCrews.filter((item) => item.id !== crewId),
  };
}

export function createPositionForLooseCrew(group: StripGroup, crewId: string): StripGroup {
  const crew = group.looseCrews.find((item) => item.id === crewId);
  if (!crew || crew.readiness === "Формується") return group;
  const linkedCrew = syncCrewSystemNote(crew, false);
  let position = createPosition([linkedCrew]);
  if (crew.readiness) {
    position = applyPositionReadiness(
      position,
      crew.readiness as PositionReadiness,
      crew.notReadyReason,
    );
  }
  return {
    ...group,
    positions: [...group.positions, position],
    looseCrews: group.looseCrews.filter((item) => item.id !== crewId),
  };
}

export function setCrewReadinessInGroup(
  group: StripGroup,
  positionId: string | null,
  crewId: string,
  readiness: CrewReadiness,
  reason = "",
): StripGroup {
  if (readiness === "Не БГ" && !reason.trim()) return group;
  if (!positionId) {
    return {
      ...group,
      looseCrews: group.looseCrews.map((crew) => crew.id === crewId
        ? syncCrewSystemNote(applyCrewReadiness(crew, readiness, reason), true)
        : crew),
    };
  }
  const position = group.positions.find((item) => item.id === positionId);
  const crew = position?.crews.find((item) => item.id === crewId);
  if (!position || !crew) return group;
  const updatedCrew = applyCrewReadiness(crew, readiness, reason);
  if (!position.readiness && readiness !== "Формується") {
    const updatedPosition = applyPositionReadiness(
      position,
      readiness as PositionReadiness,
      reason,
    );
    return {
      ...group,
      positions: group.positions.map((item) => item.id === positionId
        ? {
            ...updatedPosition,
            crews: item.crews.map((candidate) => candidate.id === crewId
              ? syncCrewSystemNote(updatedCrew, false)
              : candidate),
          }
        : item),
    };
  }
  const mustDetach = readiness === "Формується"
    || Boolean(position.readiness && updatedCrew.readiness !== position.readiness);
  if (mustDetach) {
    return {
      ...group,
      positions: group.positions.map((item) => item.id === positionId
        ? syncPositionSystemNote({
            ...item,
            crews: item.crews.filter((candidate) => candidate.id !== crewId),
          })
        : item),
      looseCrews: group.looseCrews.some((item) => item.id === crewId)
        ? group.looseCrews
        : [...group.looseCrews, syncCrewSystemNote(updatedCrew, true)],
    };
  }
  return {
    ...group,
    positions: group.positions.map((item) => item.id === positionId
      ? {
          ...item,
          crews: item.crews.map((candidate) => candidate.id === crewId
            ? syncCrewSystemNote(updatedCrew, false)
            : candidate),
        }
      : item),
  };
}

export function setPositionReadinessInGroup(
  group: StripGroup,
  positionId: string,
  readiness: PositionReadiness,
  reason = "",
): StripGroup {
  if (readiness === "Не БГ" && !reason.trim()) return group;
  const position = group.positions.find((item) => item.id === positionId);
  if (!position) return group;
  const updatedPosition = applyPositionReadiness(position, readiness, reason);
  const compatible: StripCrew[] = [];
  const detached: StripCrew[] = [];
  updatedPosition.crews.forEach((crew) => {
    if (!crew.readiness) {
      compatible.push(syncCrewSystemNote(applyCrewReadiness(crew, readiness, reason), false));
    } else if (crew.readiness === readiness) compatible.push(syncCrewSystemNote(crew, false));
    else detached.push(syncCrewSystemNote(crew, true));
  });
  return {
    ...group,
    positions: group.positions.map((item) => item.id === positionId
      ? syncPositionSystemNote({ ...updatedPosition, crews: compatible })
      : item),
    looseCrews: [
      ...group.looseCrews,
      ...detached.filter((crew) => !group.looseCrews.some((item) => item.id === crew.id)),
    ],
  };
}

function missing(value: string): boolean {
  return value.trim().length === 0;
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk-UA");
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2200
    && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function crewProblems(crew: StripCrew, label: string): string[] {
  const problems: string[] = [];
  if (missing(crew.name)) problems.push(`${label}: вкажіть назву екіпажу.`);
  if (!crew.readiness) problems.push(`${label}: оберіть БГ екіпажу.`);
  if (crew.readiness === "Не БГ" && missing(crew.notReadyReason)) {
    problems.push(`${label}: вкажіть причину статусу «Не БГ».`);
  }
  if (crew.readiness === "Формується" && crew.duty !== "Формується") {
    problems.push(`${label}: для статусу «Формується» значення БЧ також має бути «Формується».`);
  }
  if (crew.readiness !== "Формується" && !CREW_DUTIES.includes(crew.duty as typeof CREW_DUTIES[number])) {
    problems.push(`${label}: оберіть БЧ або «Відпочинок після БЧ».`);
  }
  return problems;
}

export function validateStripsReportErrors(report: StripsReport): string[] {
  const problems: string[] = [];
  if (!validIsoDate(report.reportDate)) problems.push("Оберіть правильну дату звіту.");
  if (report.strips.length === 0) problems.push("Додайте хоча б одну смугу.");
  const ids = new Set<string>();
  const crewNames = new Map<string, string>();
  const checkUniqueId = (value: string, label: string) => {
    if (missing(value)) {
      problems.push(`${label}: службовий ідентифікатор відсутній.`);
      return;
    }
    if (ids.has(value)) {
      problems.push(`${label}: виявлено повторений блок. Видаліть його та додайте заново.`);
      return;
    }
    ids.add(value);
  };
  const checkUniqueCrewName = (crew: StripCrew, label: string) => {
    const key = normalizedLabel(crew.name);
    if (!key) return;
    const previous = crewNames.get(key);
    if (previous) {
      problems.push(`${label}: назва екіпажу «${crew.name.trim()}» уже використана в «${previous}». Екіпаж може бути лише в одному місці.`);
      return;
    }
    crewNames.set(key, label);
  };

  for (const [stripIndex, strip] of report.strips.entries()) {
    const stripLabel = `Смуга ${stripIndex + 1}`;
    const stripName = missing(strip.name) ? stripLabel : strip.name;
    checkUniqueId(strip.id, stripLabel);
    if (missing(strip.name)) problems.push(`${stripLabel}: вкажіть назву.`);
    if (strip.groups.length === 0) {
      problems.push(`${stripName}: додайте хоча б один блок підрозділу та типу БпЛА.`);
    }

    const typeRuns = new Set<string>();
    const unitsByType = new Set<string>();
    let previousType = "";

    for (const [groupIndex, group] of strip.groups.entries()) {
      const groupLabel = `${stripName}, блок ${groupIndex + 1}`;
      checkUniqueId(group.id, groupLabel);
      if (missing(group.unit)) problems.push(`${groupLabel}: вкажіть підрозділ.`);
      if (!group.uavType) problems.push(`${groupLabel}: оберіть тип БпЛА.`);
      const typeKey = normalizedLabel(group.uavType);
      if (typeKey && typeKey !== previousType) {
        if (typeRuns.has(typeKey)) {
          problems.push(`${groupLabel}: тип БпЛА «${group.uavType}» уже доданий у цій смузі. Додавайте підрозділи кнопкою «Підрозділ» у спільному блоці типу.`);
        } else {
          typeRuns.add(typeKey);
        }
      }
      previousType = typeKey;
      const unitKey = normalizedLabel(group.unit);
      if (typeKey && unitKey) {
        const key = `${typeKey}\u0000${unitKey}`;
        if (unitsByType.has(key)) {
          problems.push(`${groupLabel}: підрозділ «${group.unit.trim()}» уже доданий до типу «${group.uavType}».`);
        } else {
          unitsByType.add(key);
        }
      }
      if (group.positions.length === 0 && group.looseCrews.length === 0) {
        problems.push(`${groupLabel}: додайте позицію або екіпаж без позиції.`);
      }

      for (const [positionIndex, position] of group.positions.entries()) {
        const label = `${groupLabel}, позиція ${positionIndex + 1}`;
        checkUniqueId(position.id, label);
        if (missing(position.name)) problems.push(`${label}: вкажіть назву позиції.`);
        if (!position.readiness) problems.push(`${label}: оберіть БГ позиції.`);
        if (position.readiness === "Не БГ" && missing(position.notReadyReason)) {
          problems.push(`${label}: вкажіть причину статусу «Не БГ».`);
        }
        if (missing(position.bro)) problems.push(`${label}: вкажіть БРО.`);
        if (missing(position.area)) problems.push(`${label}: вкажіть район.`);
        if (missing(position.direction)) problems.push(`${label}: вкажіть напрямок роботи.`);
        for (const [crewIndex, crew] of position.crews.entries()) {
          const crewLabel = `${label}, екіпаж ${crewIndex + 1}`;
          checkUniqueId(crew.id, crewLabel);
          problems.push(...crewProblems(crew, crewLabel));
          checkUniqueCrewName(crew, crewLabel);
          if (crew.readiness === "Формується") {
            problems.push(`${crewLabel}: екіпаж, що формується, не може бути закріплений за позицією.`);
          }
          if (crew.readiness && position.readiness && crew.readiness !== position.readiness) {
            problems.push(`${crewLabel}: статус екіпажу має збігатися зі статусом позиції.`);
          }
        }
      }

      for (const [crewIndex, crew] of group.looseCrews.entries()) {
        const label = `${groupLabel}, екіпаж без позиції ${crewIndex + 1}`;
        checkUniqueId(crew.id, label);
        problems.push(...crewProblems(crew, label));
        checkUniqueCrewName(crew, label);
      }
    }
  }
  return problems;
}

export function validateStripsReport(report: StripsReport): string {
  return validateStripsReportErrors(report).join("\n");
}

function emptyCounts(): StatusCounts {
  return { ready: 0, notReady: 0, forming: 0, total: 0 };
}

function addStatus(counts: StatusCounts, status: string) {
  if (!CREW_READINESS.includes(status as CrewReadiness)) return;
  counts.total += 1;
  if (status === "БГ") counts.ready += 1;
  else if (status === "Не БГ") counts.notReady += 1;
  else if (status === "Формується") counts.forming += 1;
}

interface LinkedCrewFact {
  strip: string;
  unit: string;
  uavType: UavType;
}

function orderedLabels(values: string[]): Array<{ key: string; label: string }> {
  const labels: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const key = normalizedLabel(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    labels.push({ key, label: value.trim() });
  });
  return labels;
}

function buildCountMatrix(
  facts: LinkedCrewFact[],
  rowValues: string[],
  columnValues: string[],
  rowValue: (fact: LinkedCrewFact) => string,
  columnValue: (fact: LinkedCrewFact) => string,
): CountMatrix {
  const rows = orderedLabels(rowValues);
  const columns = orderedLabels(columnValues);
  const counts = new Map<string, Map<string, number>>();
  facts.forEach((fact) => {
    const rowKey = normalizedLabel(rowValue(fact));
    const columnKey = normalizedLabel(columnValue(fact));
    const row = counts.get(rowKey) ?? new Map<string, number>();
    row.set(columnKey, (row.get(columnKey) ?? 0) + 1);
    counts.set(rowKey, row);
  });
  const matrixRows = rows.map(({ key, label }) => {
    const values = columns.map((column) => counts.get(key)?.get(column.key) ?? 0);
    return { label, values, total: values.reduce((sum, value) => sum + value, 0) };
  }).filter((row) => row.total > 0);
  const columnTotals = columns.map((_, columnIndex) => matrixRows.reduce(
    (sum, row) => sum + row.values[columnIndex],
    0,
  ));
  return {
    columns: columns.filter((_, index) => columnTotals[index] > 0).map((column) => column.label),
    rows: matrixRows.map((row) => ({
      ...row,
      values: row.values.filter((_, index) => columnTotals[index] > 0),
    })),
    columnTotals: columnTotals.filter((value) => value > 0),
    total: matrixRows.reduce((sum, row) => sum + row.total, 0),
  };
}

export function calculateStripsSummary(strips: WorkStrip[]): StripsSummary {
  const crewByType = new Map<UavType, StatusCounts>();
  const positionByType = new Map<UavType, StatusCounts>();
  const looseCrewsByType = new Map<UavType, number>();
  const emptyPositionsByType = new Map<UavType, number>();
  const seenPositions = new Set<string>();
  const seenCrews = new Set<string>();
  const linkedCrewFacts: LinkedCrewFact[] = [];
  let crewsWithoutPosition = 0;
  let positionsWithoutCrews = 0;

  const countsFor = (map: Map<UavType, StatusCounts>, uavType: UavType) => {
    const current = map.get(uavType);
    if (current) return current;
    const created = emptyCounts();
    map.set(uavType, created);
    return created;
  };

  strips.forEach((strip) => {
    strip.groups.forEach((group) => {
      if (!group.uavType) return;
      group.positions.forEach((position) => {
        if (seenPositions.has(position.id)) return;
        seenPositions.add(position.id);
        if (position.crews.length === 0) {
          positionsWithoutCrews += 1;
          emptyPositionsByType.set(
            group.uavType as UavType,
            (emptyPositionsByType.get(group.uavType as UavType) ?? 0) + 1,
          );
          return;
        }
        addStatus(countsFor(positionByType, group.uavType as UavType), position.readiness);
        position.crews.forEach((crew) => {
          const nameKey = normalizedLabel(crew.name);
          const crewKey = nameKey ? `name:${nameKey}` : `id:${crew.id}`;
          if (seenCrews.has(crewKey)) return;
          seenCrews.add(crewKey);
          addStatus(countsFor(crewByType, group.uavType as UavType), crew.readiness);
          if (CREW_READINESS.includes(crew.readiness as CrewReadiness)) {
            linkedCrewFacts.push({
              strip: strip.name,
              unit: group.unit,
              uavType: group.uavType as UavType,
            });
          }
        });
      });
      group.looseCrews.forEach((crew) => {
        const nameKey = normalizedLabel(crew.name);
        const crewKey = nameKey ? `name:${nameKey}` : `id:${crew.id}`;
        if (seenCrews.has(crewKey)) return;
        seenCrews.add(crewKey);
        crewsWithoutPosition += 1;
        looseCrewsByType.set(
          group.uavType as UavType,
          (looseCrewsByType.get(group.uavType as UavType) ?? 0) + 1,
        );
      });
    });
  });

  const rows = (map: Map<UavType, StatusCounts>): UavSummaryRow[] => UAV_TYPES
    .filter((uavType) => (map.get(uavType)?.total ?? 0) > 0)
    .map((uavType) => ({ uavType, ...(map.get(uavType) as StatusCounts) }));
  const crews = rows(crewByType);
  const positions = rows(positionByType);
  const exceptions = UAV_TYPES
    .filter((uavType) => (looseCrewsByType.get(uavType) ?? 0) + (emptyPositionsByType.get(uavType) ?? 0) > 0)
    .map((uavType) => ({
      uavType,
      crewsWithoutPosition: looseCrewsByType.get(uavType) ?? 0,
      positionsWithoutCrews: emptyPositionsByType.get(uavType) ?? 0,
    }));
  const total = (values: UavSummaryRow[]): StatusCounts => values.reduce((sum, row) => ({
    ready: sum.ready + row.ready,
    notReady: sum.notReady + row.notReady,
    forming: sum.forming + row.forming,
    total: sum.total + row.total,
  }), emptyCounts());
  const units = linkedCrewFacts.map((fact) => fact.unit);
  const stripNames = strips
    .map((strip) => strip.name)
    .filter((stripName) => linkedCrewFacts.some((fact) => normalizedLabel(fact.strip) === normalizedLabel(stripName)));
  const uavTypes = UAV_TYPES.filter((uavType) => linkedCrewFacts.some((fact) => fact.uavType === uavType));

  return {
    crews,
    positions,
    crewTotals: total(crews),
    positionTotals: total(positions),
    exceptions,
    crewsWithoutPosition,
    positionsWithoutCrews,
    crewsByUnitAndStrip: buildCountMatrix(
      linkedCrewFacts,
      units,
      stripNames,
      (fact) => fact.unit,
      (fact) => fact.strip,
    ),
    crewsByUnitAndUavType: buildCountMatrix(
      linkedCrewFacts,
      units,
      uavTypes,
      (fact) => fact.unit,
      (fact) => fact.uavType,
    ),
    crewsByStripAndUavType: buildCountMatrix(
      linkedCrewFacts,
      stripNames,
      uavTypes,
      (fact) => fact.strip,
      (fact) => fact.uavType,
    ),
  };
}

export function normalizeStripsReport(value: unknown): StripsReport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StripsReport>;
  if (candidate.version !== 1 || typeof candidate.reportDate !== "string" || !Array.isArray(candidate.strips)) {
    return null;
  }
  const ids = new Set<string>();
  const acceptId = (value: unknown): value is string => {
    if (typeof value !== "string" || !value || ids.has(value)) return false;
    ids.add(value);
    return true;
  };
  const uavTypes = new Set<string>(UAV_TYPES);
  const normalized: WorkStrip[] = [];
  for (const rawStrip of candidate.strips) {
    if (!rawStrip || typeof rawStrip !== "object") return null;
    const strip = rawStrip as Partial<WorkStrip>;
    if (!acceptId(strip.id) || typeof strip.name !== "string" || !Array.isArray(strip.groups)) return null;
    const groups = strip.groups.map((raw): StripGroup | null => {
      if (!raw || typeof raw !== "object") return null;
      const group = raw as Partial<StripGroup>;
      if (!acceptId(group.id) || !Array.isArray(group.positions) || !Array.isArray(group.looseCrews)) return null;
      const positions = group.positions.map((item): StripPosition | null => normalizePosition(item, acceptId));
      const looseCrews = group.looseCrews.map((item): StripCrew | null => normalizeCrew(item, acceptId));
      if (positions.some((position) => position === null) || looseCrews.some((crew) => crew === null)) return null;
      const migrated = normalizeGroupLinks(
        positions as StripPosition[],
        looseCrews as StripCrew[],
      );
      return {
        id: group.id,
        unit: typeof group.unit === "string" ? group.unit : "",
        uavType: typeof group.uavType === "string" && uavTypes.has(group.uavType)
          ? group.uavType as UavType
          : "",
        positions: migrated.positions,
        looseCrews: migrated.looseCrews,
      };
    });
    if (groups.some((group) => group === null)) return null;
    normalized.push({ id: strip.id, name: strip.name, groups: groups as StripGroup[] });
  }
  return { version: 1, reportDate: candidate.reportDate, strips: normalized };
}

function normalizeGroupLinks(
  positions: StripPosition[],
  looseCrews: StripCrew[],
): Pick<StripGroup, "positions" | "looseCrews"> {
  const detached = [...looseCrews];
  const detach = (crew: StripCrew) => {
    if (!detached.some((item) => item.id === crew.id)) detached.push(crew);
  };
  const migratedPositions = positions.map((position) => {
    const firstUsableStatus = position.crews.find((crew) => crew.readiness && crew.readiness !== "Формується")
      ?.readiness as PositionReadiness | undefined;
    const targetStatus = position.readiness || firstUsableStatus || "";
    const targetReason = position.readiness === "Не БГ"
      ? position.notReadyReason
      : position.crews.find((crew) => crew.readiness === "Не БГ")?.notReadyReason ?? "";
    const migratedPosition = !position.readiness && targetStatus
      ? applyPositionReadiness(position, targetStatus, targetReason)
      : position;
    const linked: StripCrew[] = [];
    position.crews.forEach((crew) => {
      if (crew.readiness === "Формується") {
        detach(syncCrewSystemNote(crew, true));
        return;
      }
      if (!targetStatus) {
        linked.push(syncCrewSystemNote(crew, false));
        return;
      }
      if (!crew.readiness) {
        linked.push(syncCrewSystemNote(applyCrewReadiness(crew, targetStatus, targetReason), false));
        return;
      }
      if (crew.readiness === targetStatus) linked.push(syncCrewSystemNote(crew, false));
      else detach(syncCrewSystemNote(crew, true));
    });
    return syncPositionSystemNote({ ...migratedPosition, crews: linked });
  });
  return {
    positions: migratedPositions,
    looseCrews: detached.map((crew) => syncCrewSystemNote(crew, true)),
  };
}

function normalizePosition(
  value: unknown,
  acceptId: (value: unknown) => value is string,
): StripPosition | null {
  if (!value || typeof value !== "object") return null;
  const position = value as Partial<StripPosition>;
  if (!acceptId(position.id) || !Array.isArray(position.crews)) return null;
  const crews = position.crews.map((item): StripCrew | null => normalizeCrew(item, acceptId));
  if (crews.some((crew) => crew === null)) return null;
  return {
    id: position.id,
    name: typeof position.name === "string" ? position.name : "",
    readiness: POSITION_READINESS.includes(position.readiness as PositionReadiness)
      ? position.readiness as PositionReadiness
      : "",
    notReadyReason: typeof position.notReadyReason === "string" ? position.notReadyReason : "",
    bro: typeof position.bro === "string" ? position.bro : "",
    area: typeof position.area === "string" ? upperUk(position.area) : "",
    direction: typeof position.direction === "string" ? position.direction : "",
    note: typeof position.note === "string" ? position.note : "",
    crews: crews as StripCrew[],
  };
}

function normalizeCrew(
  value: unknown,
  acceptId: (value: unknown) => value is string,
): StripCrew | null {
  if (!value || typeof value !== "object") return null;
  const crew = value as Partial<StripCrew>;
  if (!acceptId(crew.id)) return null;
  const readiness = CREW_READINESS.includes(crew.readiness as CrewReadiness)
    ? crew.readiness as CrewReadiness
    : "";
  let duty: CrewDuty | "" = CREW_DUTIES.includes(crew.duty as typeof CREW_DUTIES[number])
    ? crew.duty as typeof CREW_DUTIES[number]
    : "";
  if (readiness === "Формується") duty = "Формується";
  return {
    id: crew.id,
    name: typeof crew.name === "string" ? crew.name : "",
    readiness,
    notReadyReason: readiness === "Не БГ" && typeof crew.notReadyReason === "string"
      ? crew.notReadyReason
      : "",
    duty,
    assets: typeof crew.assets === "string" ? crew.assets : "",
    note: typeof crew.note === "string" ? crew.note : "",
  };
}
