import { UAV_TYPES } from "./structure";
import {
  CREW_DUTIES,
  CREW_READINESS,
  POSITION_READINESS,
  syncCrewSystemNote,
  syncPositionSystemNote,
  upperUk,
  type CrewDuty,
  type CrewReadiness,
  type PositionReadiness,
  type StripCrew,
  type StripGroup,
  type StripPosition,
  type StripsReport,
  type UavType,
  type WorkStrip,
} from "./strips";

export interface RegistryCrew {
  id: string;
  name: string;
  strip: string;
  unit: string;
  uavType: UavType | "";
  readiness: CrewReadiness | "";
  notReadyReason: string;
  duty: CrewDuty | "";
  assets: string;
  note: string;
}

export interface RegistryPosition {
  id: string;
  name: string;
  strip: string;
  unit: string;
  uavType: UavType | "";
  readiness: PositionReadiness | "";
  notReadyReason: string;
  bro: string;
  area: string;
  direction: string;
  note: string;
}

export interface RegistryAssignment {
  id: string;
  crewId: string;
  positionId: string;
}

export interface StripsRegistryData {
  version: 1;
  reportDate: string;
  crews: RegistryCrew[];
  positions: RegistryPosition[];
  assignments: RegistryAssignment[];
}

export interface EffectiveCrewLocation {
  position: RegistryPosition | null;
  strip: string;
  unit: string;
  uavType: UavType | "";
  bro: string;
  area: string;
  direction: string;
}

let nextRegistryId = 1;

function registryId(prefix: string): string {
  return `${prefix}-${Date.now()}-${nextRegistryId++}`;
}

export function createRegistryCrew(): RegistryCrew {
  return {
    id: registryId("registry-crew"),
    name: "",
    strip: "",
    unit: "",
    uavType: "",
    readiness: "",
    notReadyReason: "",
    duty: "",
    assets: "",
    note: "",
  };
}

export function createRegistryPosition(): RegistryPosition {
  return {
    id: registryId("registry-position"),
    name: "",
    strip: "",
    unit: "",
    uavType: "",
    readiness: "",
    notReadyReason: "",
    bro: "",
    area: "",
    direction: "",
    note: "",
  };
}

export function createRegistryAssignment(): RegistryAssignment {
  return {
    id: registryId("registry-assignment"),
    crewId: "",
    positionId: "",
  };
}

export function createEmptyStripsRegistry(reportDate: string): StripsRegistryData {
  return { version: 1, reportDate, crews: [], positions: [], assignments: [] };
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

function missing(value: string): boolean {
  return value.trim().length === 0;
}

export function positionForCrew(
  data: StripsRegistryData,
  crewId: string,
): RegistryPosition | null {
  const assignment = data.assignments.find((item) => item.crewId === crewId && item.positionId);
  if (!assignment) return null;
  return data.positions.find((position) => position.id === assignment.positionId) ?? null;
}

export function effectiveCrewLocation(
  data: StripsRegistryData,
  crew: RegistryCrew,
): EffectiveCrewLocation {
  const position = positionForCrew(data, crew.id);
  return position
    ? {
        position,
        strip: position.strip,
        unit: position.unit,
        uavType: position.uavType,
        bro: position.bro,
        area: position.area,
        direction: position.direction,
      }
    : {
        position: null,
        strip: crew.strip,
        unit: crew.unit,
        uavType: crew.uavType,
        bro: "",
        area: "",
        direction: "",
      };
}

export function validateStripsRegistry(data: StripsRegistryData): string[] {
  const problems: string[] = [];
  if (!validIsoDate(data.reportDate)) problems.push("Оберіть правильну дату звіту.");
  if (data.crews.length === 0 && data.positions.length === 0) {
    problems.push("Додайте хоча б один екіпаж або одну позицію.");
  }

  const ids = new Set<string>();
  const checkId = (id: string, label: string) => {
    if (!id) problems.push(`${label}: службовий ідентифікатор відсутній.`);
    else if (ids.has(id)) problems.push(`${label}: виявлено повторений запис.`);
    else ids.add(id);
  };
  const crewNames = new Map<string, string>();

  data.crews.forEach((crew, index) => {
    const label = `Екіпаж ${index + 1}`;
    checkId(crew.id, label);
    if (missing(crew.name)) problems.push(`${label}: вкажіть назву.`);
    else {
      const key = normalizedLabel(crew.name);
      const previous = crewNames.get(key);
      if (previous) problems.push(`${label}: назва «${crew.name.trim()}» уже використана в «${previous}».`);
      else crewNames.set(key, label);
    }
    if (missing(crew.strip)) problems.push(`${label}: вкажіть смугу.`);
    if (missing(crew.unit)) problems.push(`${label}: вкажіть підрозділ.`);
    if (!crew.uavType) problems.push(`${label}: оберіть тип БпЛА.`);
    if (!crew.readiness) problems.push(`${label}: оберіть БГ екіпажу.`);
    if (crew.readiness === "Не БГ" && missing(crew.notReadyReason)) {
      problems.push(`${label}: вкажіть причину статусу «Не БГ».`);
    }
    if (crew.readiness === "Формується" && crew.duty !== "Формується") {
      problems.push(`${label}: для статусу «Формується» БЧ також має бути «Формується».`);
    }
    if (crew.readiness !== "Формується" && !CREW_DUTIES.includes(crew.duty as typeof CREW_DUTIES[number])) {
      problems.push(`${label}: оберіть БЧ або «Відпочинок після БЧ».`);
    }
  });

  data.positions.forEach((position, index) => {
    const label = `Позиція ${index + 1}`;
    checkId(position.id, label);
    if (missing(position.name)) problems.push(`${label}: вкажіть назву.`);
    if (missing(position.strip)) problems.push(`${label}: вкажіть смугу.`);
    if (missing(position.unit)) problems.push(`${label}: вкажіть підрозділ.`);
    if (!position.uavType) problems.push(`${label}: оберіть тип БпЛА.`);
    if (!position.readiness) problems.push(`${label}: оберіть БГ позиції.`);
    if (position.readiness === "Не БГ" && missing(position.notReadyReason)) {
      problems.push(`${label}: вкажіть причину статусу «Не БГ».`);
    }
    if (missing(position.bro)) problems.push(`${label}: вкажіть БРО.`);
    if (missing(position.area)) problems.push(`${label}: вкажіть район.`);
    if (missing(position.direction)) problems.push(`${label}: вкажіть напрямок роботи.`);
  });

  const crewsById = new Map(data.crews.map((crew) => [crew.id, crew]));
  const positionsById = new Map(data.positions.map((position) => [position.id, position]));
  const assignedCrews = new Set<string>();
  data.assignments.forEach((assignment, index) => {
    const label = `Розподіл ${index + 1}`;
    checkId(assignment.id, label);
    if (!assignment.crewId) problems.push(`${label}: оберіть екіпаж.`);
    if (!assignment.positionId) problems.push(`${label}: оберіть позицію.`);
    const crew = crewsById.get(assignment.crewId);
    const position = positionsById.get(assignment.positionId);
    if (assignment.crewId && !crew) problems.push(`${label}: обраного екіпажу більше немає в реєстрі.`);
    if (assignment.positionId && !position) problems.push(`${label}: обраної позиції більше немає в реєстрі.`);
    if (crew) {
      if (assignedCrews.has(crew.id)) problems.push(`${label}: екіпаж «${crew.name || "Без назви"}» уже розподілений.`);
      else assignedCrews.add(crew.id);
      if (crew.readiness === "Формується") {
        problems.push(`${label}: екіпаж зі статусом «Формується» не може мати позицію.`);
      }
    }
    if (crew?.readiness && position?.readiness && crew.readiness !== position.readiness) {
      problems.push(`${label}: статус екіпажу має збігатися зі статусом позиції.`);
    }
  });

  return problems;
}

interface GroupBuilder {
  stripName: string;
  unit: string;
  uavType: UavType | "";
  positions: StripPosition[];
  looseCrews: StripCrew[];
  order: number;
}

function toStripCrew(crew: RegistryCrew, withoutPosition: boolean): StripCrew {
  return syncCrewSystemNote({
    id: crew.id,
    name: crew.name,
    readiness: crew.readiness,
    notReadyReason: crew.readiness === "Не БГ" ? crew.notReadyReason : "",
    duty: crew.readiness === "Формується" ? "Формується" : crew.duty,
    assets: crew.assets,
    note: crew.note,
  }, withoutPosition);
}

export function registryToStripsReport(data: StripsRegistryData): StripsReport {
  const crewsById = new Map(data.crews.map((crew) => [crew.id, crew]));
  const linkedCrewIds = new Set<string>();
  const crewsByPosition = new Map<string, RegistryCrew[]>();
  data.assignments.forEach((assignment) => {
    const crew = crewsById.get(assignment.crewId);
    if (!crew || !data.positions.some((position) => position.id === assignment.positionId)) return;
    if (linkedCrewIds.has(crew.id)) return;
    linkedCrewIds.add(crew.id);
    const list = crewsByPosition.get(assignment.positionId) ?? [];
    list.push(crew);
    crewsByPosition.set(assignment.positionId, list);
  });

  const builders = new Map<string, GroupBuilder>();
  let nextOrder = 0;
  const builderFor = (stripName: string, unit: string, uavType: UavType | "") => {
    const key = `${normalizedLabel(stripName)}\u0000${normalizedLabel(uavType)}\u0000${normalizedLabel(unit)}`;
    const current = builders.get(key);
    if (current) return current;
    const created: GroupBuilder = {
      stripName,
      unit,
      uavType,
      positions: [],
      looseCrews: [],
      order: nextOrder++,
    };
    builders.set(key, created);
    return created;
  };

  data.positions.forEach((position) => {
    const crews = (crewsByPosition.get(position.id) ?? []).map((crew) => toStripCrew(crew, false));
    const exportedPosition: StripPosition = syncPositionSystemNote({
      id: position.id,
      name: position.name,
      readiness: position.readiness,
      notReadyReason: position.readiness === "Не БГ" ? position.notReadyReason : "",
      bro: position.bro,
      area: upperUk(position.area),
      direction: position.direction,
      note: position.note,
      crews,
    });
    builderFor(position.strip, position.unit, position.uavType).positions.push(exportedPosition);
  });

  data.crews.forEach((crew) => {
    if (linkedCrewIds.has(crew.id)) return;
    builderFor(crew.strip, crew.unit, crew.uavType).looseCrews.push(toStripCrew(crew, true));
  });

  const stripNames: string[] = [];
  const stripKeys = new Set<string>();
  [...builders.values()].sort((a, b) => a.order - b.order).forEach((builder) => {
    const key = normalizedLabel(builder.stripName);
    if (stripKeys.has(key)) return;
    stripKeys.add(key);
    stripNames.push(builder.stripName);
  });

  const strips: WorkStrip[] = stripNames.map((stripName, stripIndex) => {
    const candidates = [...builders.values()].filter(
      (builder) => normalizedLabel(builder.stripName) === normalizedLabel(stripName),
    );
    const groups: StripGroup[] = candidates
      .sort((a, b) => {
        const aType = UAV_TYPES.indexOf(a.uavType as UavType);
        const bType = UAV_TYPES.indexOf(b.uavType as UavType);
        const safeA = aType < 0 ? UAV_TYPES.length : aType;
        const safeB = bType < 0 ? UAV_TYPES.length : bType;
        return safeA - safeB || a.order - b.order;
      })
      .map((builder, groupIndex) => ({
        id: `registry-group-${stripIndex + 1}-${groupIndex + 1}`,
        unit: builder.unit,
        uavType: builder.uavType,
        positions: builder.positions,
        looseCrews: builder.looseCrews,
      }));
    return { id: `registry-strip-${stripIndex + 1}`, name: stripName, groups };
  });

  return { version: 1, reportDate: data.reportDate, strips };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeStripsRegistry(value: unknown): StripsRegistryData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StripsRegistryData>;
  if (candidate.version !== 1
    || typeof candidate.reportDate !== "string"
    || !Array.isArray(candidate.crews)
    || !Array.isArray(candidate.positions)
    || !Array.isArray(candidate.assignments)) return null;

  const uavTypes = new Set<string>(UAV_TYPES);
  const crews: RegistryCrew[] = [];
  const positions: RegistryPosition[] = [];
  const assignments: RegistryAssignment[] = [];

  for (const raw of candidate.crews) {
    if (!raw || typeof raw !== "object") return null;
    const crew = raw as Partial<RegistryCrew>;
    if (typeof crew.id !== "string" || !crew.id) return null;
    const readiness = CREW_READINESS.includes(crew.readiness as CrewReadiness)
      ? crew.readiness as CrewReadiness
      : "";
    crews.push({
      id: crew.id,
      name: stringValue(crew.name),
      strip: stringValue(crew.strip),
      unit: stringValue(crew.unit),
      uavType: typeof crew.uavType === "string" && uavTypes.has(crew.uavType)
        ? crew.uavType as UavType
        : "",
      readiness,
      notReadyReason: readiness === "Не БГ" ? stringValue(crew.notReadyReason) : "",
      duty: readiness === "Формується"
        ? "Формується"
        : CREW_DUTIES.includes(crew.duty as typeof CREW_DUTIES[number])
          ? crew.duty as typeof CREW_DUTIES[number]
          : "",
      assets: stringValue(crew.assets),
      note: stringValue(crew.note),
    });
  }

  for (const raw of candidate.positions) {
    if (!raw || typeof raw !== "object") return null;
    const position = raw as Partial<RegistryPosition>;
    if (typeof position.id !== "string" || !position.id) return null;
    const readiness = POSITION_READINESS.includes(position.readiness as PositionReadiness)
      ? position.readiness as PositionReadiness
      : "";
    positions.push({
      id: position.id,
      name: stringValue(position.name),
      strip: stringValue(position.strip),
      unit: stringValue(position.unit),
      uavType: typeof position.uavType === "string" && uavTypes.has(position.uavType)
        ? position.uavType as UavType
        : "",
      readiness,
      notReadyReason: readiness === "Не БГ" ? stringValue(position.notReadyReason) : "",
      bro: stringValue(position.bro),
      area: upperUk(stringValue(position.area)),
      direction: stringValue(position.direction),
      note: stringValue(position.note),
    });
  }

  for (const raw of candidate.assignments) {
    if (!raw || typeof raw !== "object") return null;
    const assignment = raw as Partial<RegistryAssignment>;
    if (typeof assignment.id !== "string" || !assignment.id) return null;
    assignments.push({
      id: assignment.id,
      crewId: stringValue(assignment.crewId),
      positionId: stringValue(assignment.positionId),
    });
  }

  return { version: 1, reportDate: candidate.reportDate, crews, positions, assignments };
}
