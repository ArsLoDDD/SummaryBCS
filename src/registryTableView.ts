import {
  readinessDisplay,
  syncCrewSystemNote,
  syncPositionSystemNote,
} from "./strips";
import {
  UNASSIGNED_STRIP_NAME,
  type RegistryAssignment,
  type RegistryCrew,
  type RegistryPosition,
  type StripsRegistryData,
} from "./stripsRegistry";

export type RegistryAssignmentState =
  | "assigned"
  | "crew-without-position"
  | "position-without-crew";

export type RegistrySortDirection = "asc" | "desc";
export type RegistryTableScope = "general" | "crews" | "positions";

export interface RegistryTableFilters {
  strips?: ReadonlyArray<string>;
  units?: ReadonlyArray<string>;
  uavTypes?: ReadonlyArray<string>;
  crewReadiness?: ReadonlyArray<string>;
  positionReadiness?: ReadonlyArray<string>;
  assignmentStates?: ReadonlyArray<RegistryAssignmentState>;
}

export interface RegistryTableViewOptions<SortKey extends string> {
  search?: string;
  filters?: RegistryTableFilters;
  sort?: {
    key: SortKey;
    direction: RegistrySortDirection;
  };
}

export interface RegistryGeneralRow {
  key: string;
  assignment: RegistryAssignment | null;
  crew: RegistryCrew | null;
  position: RegistryPosition | null;
}

export type RegistryGeneralSortKey =
  | "crew"
  | "position"
  | "strip"
  | "unit"
  | "uavType"
  | "crewReadiness"
  | "duty"
  | "assets"
  | "positionReadiness"
  | "bro"
  | "area"
  | "direction"
  | "note"
  | "assignmentState";

export type RegistryCrewSortKey =
  | "name"
  | "unit"
  | "uavType"
  | "readiness"
  | "duty"
  | "assets"
  | "note"
  | "strip"
  | "position"
  | "positionReadiness"
  | "assignmentState";

export type RegistryPositionSortKey =
  | "name"
  | "strip"
  | "unit"
  | "uavType"
  | "readiness"
  | "bro"
  | "area"
  | "direction"
  | "note"
  | "crewReadiness"
  | "assignmentState";

export interface RegistryTableFilterOptions {
  strips: string[];
  units: string[];
  uavTypes: string[];
  crewReadiness: string[];
  positionReadiness: string[];
  assignmentStates: RegistryAssignmentState[];
}

interface RegistryRelations {
  assignmentByCrewId: Map<string, RegistryAssignment>;
  positionById: Map<string, RegistryPosition>;
  crewsByPositionId: Map<string, RegistryCrew[]>;
}

interface CompiledFilters {
  strips: Set<string>;
  units: Set<string>;
  uavTypes: Set<string>;
  crewReadiness: Set<string>;
  positionReadiness: Set<string>;
  assignmentStates: Set<RegistryAssignmentState>;
}

const collator = new Intl.Collator("uk-UA", {
  numeric: true,
  sensitivity: "base",
});

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk-UA");
}

function normalizedSet(values: ReadonlyArray<string> | undefined): Set<string> {
  return new Set((values ?? []).map(normalized).filter(Boolean));
}

function compileFilters(filters: RegistryTableFilters | undefined): CompiledFilters {
  return {
    strips: normalizedSet(filters?.strips),
    units: normalizedSet(filters?.units),
    uavTypes: normalizedSet(filters?.uavTypes),
    crewReadiness: normalizedSet(filters?.crewReadiness),
    positionReadiness: normalizedSet(filters?.positionReadiness),
    assignmentStates: new Set(filters?.assignmentStates ?? []),
  };
}

function matchesSelected(value: string, selected: Set<string>): boolean {
  return selected.size === 0 || selected.has(normalized(value));
}

function matchesAnySelected(values: ReadonlyArray<string>, selected: Set<string>): boolean {
  return selected.size === 0 || values.some((value) => selected.has(normalized(value)));
}

function matchesAssignmentState(
  value: RegistryAssignmentState,
  selected: Set<RegistryAssignmentState>,
): boolean {
  return selected.size === 0 || selected.has(value);
}

function matchesSearch(values: ReadonlyArray<string>, search: string | undefined): boolean {
  const tokens = normalized(search ?? "").split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalized(values.join(" "));
  return tokens.every((token) => haystack.includes(token));
}

function createRelations(data: StripsRegistryData): RegistryRelations {
  const positionById = new Map(data.positions.map((position) => [position.id, position]));
  const crewById = new Map(data.crews.map((crew) => [crew.id, crew]));
  const assignmentByCrewId = new Map<string, RegistryAssignment>();
  const crewsByPositionId = new Map<string, RegistryCrew[]>();

  for (const assignment of data.assignments) {
    const crew = crewById.get(assignment.crewId);
    if (!crew || !positionById.has(assignment.positionId) || assignmentByCrewId.has(assignment.crewId)) continue;
    assignmentByCrewId.set(assignment.crewId, assignment);
    const crews = crewsByPositionId.get(assignment.positionId) ?? [];
    crews.push(crew);
    crewsByPositionId.set(assignment.positionId, crews);
  }

  return { assignmentByCrewId, positionById, crewsByPositionId };
}

function positionForCrew(
  crew: RegistryCrew,
  relations: RegistryRelations,
): RegistryPosition | null {
  const assignment = relations.assignmentByCrewId.get(crew.id);
  return assignment ? relations.positionById.get(assignment.positionId) ?? null : null;
}

function compareValues(left: string, right: string, direction: RegistrySortDirection): number {
  const normalizedLeft = normalized(left);
  const normalizedRight = normalized(right);
  if (!normalizedLeft && !normalizedRight) return 0;
  if (!normalizedLeft) return 1;
  if (!normalizedRight) return -1;
  const result = collator.compare(normalizedLeft, normalizedRight);
  return direction === "asc" ? result : -result;
}

function stableSort<T>(
  rows: ReadonlyArray<T>,
  valueFor: (row: T) => string,
  direction: RegistrySortDirection,
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => compareValues(valueFor(left.row), valueFor(right.row), direction)
      || left.index - right.index)
    .map(({ row }) => row);
}

function crewReadinessLabel(crew: RegistryCrew | null): string {
  if (!crew?.readiness) return "";
  return readinessDisplay(crew.readiness, crew.notReadyReason);
}

function positionReadinessLabel(position: RegistryPosition | null): string {
  if (!position?.readiness) return "";
  return readinessDisplay(position.readiness, position.notReadyReason);
}

export function registryGeneralRowNote(row: RegistryGeneralRow): string {
  const crewNote = row.crew
    ? syncCrewSystemNote(row.crew, !row.position).note
    : "";
  const positionNote = row.position
    ? syncPositionSystemNote({ ...row.position, crews: row.crew ? [row.crew] : [] }).note
    : "";
  return [crewNote, positionNote].filter(Boolean).join(" / ");
}

export function registryGeneralAssignmentState(row: RegistryGeneralRow): RegistryAssignmentState {
  if (row.crew && row.position) return "assigned";
  if (row.crew) return "crew-without-position";
  return "position-without-crew";
}

export function buildRegistryGeneralRows(data: StripsRegistryData): RegistryGeneralRow[] {
  const relations = createRelations(data);
  const rows: RegistryGeneralRow[] = data.crews.map((crew) => {
    const assignment = relations.assignmentByCrewId.get(crew.id) ?? null;
    const position = assignment
      ? relations.positionById.get(assignment.positionId) ?? null
      : null;
    return { key: `crew-${crew.id}`, crew, position, assignment };
  });
  const usedPositionIds = new Set(rows.map((row) => row.position?.id).filter(Boolean));
  for (const position of data.positions) {
    if (!usedPositionIds.has(position.id)) {
      rows.push({ key: `position-${position.id}`, crew: null, position, assignment: null });
    }
  }
  return rows;
}

function generalVisibleUnit(row: RegistryGeneralRow): string {
  return row.crew?.unit || row.position?.unit || "";
}

function generalVisibleUavType(row: RegistryGeneralRow): string {
  return row.crew?.uavType || row.position?.uavType || "";
}

function generalSearchValues(row: RegistryGeneralRow): string[] {
  return [
    row.crew?.name || "Позиція без екіпажу",
    row.position?.name || "Екіпаж без позиції",
    row.position?.strip || "",
    generalVisibleUnit(row),
    generalVisibleUavType(row),
    crewReadinessLabel(row.crew),
    row.crew?.duty || "",
    row.crew?.assets || "",
    positionReadinessLabel(row.position),
    row.position?.bro || "",
    row.position?.area || "",
    row.position?.direction || "",
    registryGeneralRowNote(row),
  ];
}

function generalSortValue(row: RegistryGeneralRow, key: RegistryGeneralSortKey): string {
  switch (key) {
    case "crew": return row.crew?.name || "";
    case "position": return row.position?.name || "";
    case "strip": return row.position?.strip || "";
    case "unit": return generalVisibleUnit(row);
    case "uavType": return generalVisibleUavType(row);
    case "crewReadiness": return crewReadinessLabel(row.crew);
    case "duty": return row.crew?.duty || "";
    case "assets": return row.crew?.assets || "";
    case "positionReadiness": return positionReadinessLabel(row.position);
    case "bro": return row.position?.bro || "";
    case "area": return row.position?.area || "";
    case "direction": return row.position?.direction || "";
    case "note": return registryGeneralRowNote(row);
    case "assignmentState": return registryGeneralAssignmentState(row);
  }
}

export function viewRegistryGeneralRows(
  data: StripsRegistryData,
  options: RegistryTableViewOptions<RegistryGeneralSortKey> = {},
): RegistryGeneralRow[] {
  const filters = compileFilters(options.filters);
  const rows = buildRegistryGeneralRows(data).filter((row) => matchesSearch(generalSearchValues(row), options.search)
    && matchesSelected(row.position?.strip || UNASSIGNED_STRIP_NAME, filters.strips)
    && matchesSelected(generalVisibleUnit(row), filters.units)
    && matchesSelected(generalVisibleUavType(row), filters.uavTypes)
    && matchesSelected(row.crew?.readiness || "", filters.crewReadiness)
    && matchesSelected(row.position?.readiness || "", filters.positionReadiness)
    && matchesAssignmentState(registryGeneralAssignmentState(row), filters.assignmentStates));

  return options.sort
    ? stableSort(rows, (row) => generalSortValue(row, options.sort!.key), options.sort.direction)
    : rows;
}

function crewAssignmentState(position: RegistryPosition | null): RegistryAssignmentState {
  return position ? "assigned" : "crew-without-position";
}

function crewSearchValues(crew: RegistryCrew): string[] {
  return [
    crew.name,
    crew.unit,
    crew.uavType,
    crewReadinessLabel(crew),
    crew.duty,
    crew.assets,
    crew.note,
  ];
}

function crewSortValue(
  crew: RegistryCrew,
  key: RegistryCrewSortKey,
  relations: RegistryRelations,
): string {
  const position = positionForCrew(crew, relations);
  switch (key) {
    case "name": return crew.name;
    case "unit": return crew.unit;
    case "uavType": return crew.uavType;
    case "readiness": return crewReadinessLabel(crew);
    case "duty": return crew.duty;
    case "assets": return crew.assets;
    case "note": return crew.note;
    case "strip": return position?.strip || "";
    case "position": return position?.name || "";
    case "positionReadiness": return positionReadinessLabel(position);
    case "assignmentState": return crewAssignmentState(position);
  }
}

export function viewRegistryCrews(
  data: StripsRegistryData,
  options: RegistryTableViewOptions<RegistryCrewSortKey> = {},
): RegistryCrew[] {
  const filters = compileFilters(options.filters);
  const relations = createRelations(data);
  const rows = data.crews.filter((crew) => {
    const position = positionForCrew(crew, relations);
    return matchesSearch(crewSearchValues(crew), options.search)
      && matchesSelected(position?.strip || UNASSIGNED_STRIP_NAME, filters.strips)
      && matchesSelected(crew.unit, filters.units)
      && matchesSelected(crew.uavType, filters.uavTypes)
      && matchesSelected(crew.readiness, filters.crewReadiness)
      && matchesSelected(position?.readiness || "", filters.positionReadiness)
      && matchesAssignmentState(crewAssignmentState(position), filters.assignmentStates);
  });

  return options.sort
    ? stableSort(rows, (crew) => crewSortValue(crew, options.sort!.key, relations), options.sort.direction)
    : [...rows];
}

function positionAssignmentState(crews: ReadonlyArray<RegistryCrew>): RegistryAssignmentState {
  return crews.length > 0 ? "assigned" : "position-without-crew";
}

function positionSearchValues(position: RegistryPosition): string[] {
  return [
    position.name,
    position.strip,
    position.unit,
    position.uavType,
    positionReadinessLabel(position),
    position.bro,
    position.area,
    position.direction,
    position.note,
  ];
}

function positionSortValue(
  position: RegistryPosition,
  key: RegistryPositionSortKey,
  relations: RegistryRelations,
): string {
  const crews = relations.crewsByPositionId.get(position.id) ?? [];
  switch (key) {
    case "name": return position.name;
    case "strip": return position.strip;
    case "unit": return position.unit;
    case "uavType": return position.uavType;
    case "readiness": return positionReadinessLabel(position);
    case "bro": return position.bro;
    case "area": return position.area;
    case "direction": return position.direction;
    case "note": return position.note;
    case "crewReadiness": return crews.map(crewReadinessLabel).join(" ");
    case "assignmentState": return positionAssignmentState(crews);
  }
}

export function viewRegistryPositions(
  data: StripsRegistryData,
  options: RegistryTableViewOptions<RegistryPositionSortKey> = {},
): RegistryPosition[] {
  const filters = compileFilters(options.filters);
  const relations = createRelations(data);
  const rows = data.positions.filter((position) => {
    const crews = relations.crewsByPositionId.get(position.id) ?? [];
    return matchesSearch(positionSearchValues(position), options.search)
      && matchesSelected(position.strip, filters.strips)
      && matchesSelected(position.unit, filters.units)
      && matchesSelected(position.uavType, filters.uavTypes)
      && matchesAnySelected(crews.map((crew) => crew.readiness), filters.crewReadiness)
      && matchesSelected(position.readiness, filters.positionReadiness)
      && matchesAssignmentState(positionAssignmentState(crews), filters.assignmentStates);
  });

  return options.sort
    ? stableSort(rows, (position) => positionSortValue(position, options.sort!.key, relations), options.sort.direction)
    : [...rows];
}

function uniqueSorted(values: Iterable<string>): string[] {
  const found = new Map<string, string>();
  for (const rawValue of values) {
    const value = rawValue.trim().replace(/\s+/g, " ");
    const key = normalized(value);
    if (key && !found.has(key)) found.set(key, value);
  }
  return [...found.values()].sort((left, right) => collator.compare(left, right));
}

export function collectRegistryTableFilterOptions(
  data: StripsRegistryData,
  scope: RegistryTableScope = "general",
): RegistryTableFilterOptions {
  const relations = createRelations(data);
  if (scope === "crews") {
    const positions = data.crews.map((crew) => positionForCrew(crew, relations));
    const states = new Set(data.crews.map((_, index) => crewAssignmentState(positions[index])));
    return {
      strips: uniqueSorted(positions.map((position) => position?.strip || UNASSIGNED_STRIP_NAME)),
      units: uniqueSorted(data.crews.map((crew) => crew.unit)),
      uavTypes: uniqueSorted(data.crews.map((crew) => crew.uavType)),
      crewReadiness: uniqueSorted(data.crews.map((crew) => crew.readiness)),
      positionReadiness: uniqueSorted(positions.map((position) => position?.readiness || "")),
      assignmentStates: (["assigned", "crew-without-position"] as RegistryAssignmentState[])
        .filter((state) => states.has(state)),
    };
  }
  if (scope === "positions") {
    const crews = data.positions.flatMap((position) => relations.crewsByPositionId.get(position.id) ?? []);
    const states = new Set(data.positions.map((position) => positionAssignmentState(
      relations.crewsByPositionId.get(position.id) ?? [],
    )));
    return {
      strips: uniqueSorted(data.positions.map((position) => position.strip)),
      units: uniqueSorted(data.positions.map((position) => position.unit)),
      uavTypes: uniqueSorted(data.positions.map((position) => position.uavType)),
      crewReadiness: uniqueSorted(crews.map((crew) => crew.readiness)),
      positionReadiness: uniqueSorted(data.positions.map((position) => position.readiness)),
      assignmentStates: (["assigned", "position-without-crew"] as RegistryAssignmentState[])
        .filter((state) => states.has(state)),
    };
  }

  const hasUnassignedCrew = data.crews.some((crew) => !data.assignments.some((item) => item.crewId === crew.id
    && data.positions.some((position) => position.id === item.positionId)));
  const states = new Set(buildRegistryGeneralRows(data).map(registryGeneralAssignmentState));
  return {
    strips: uniqueSorted([
      ...data.positions.map((position) => position.strip),
      ...(hasUnassignedCrew ? [UNASSIGNED_STRIP_NAME] : []),
    ]),
    units: uniqueSorted([
      ...data.crews.map((crew) => crew.unit),
      ...data.positions.map((position) => position.unit),
    ]),
    uavTypes: uniqueSorted([
      ...data.crews.map((crew) => crew.uavType),
      ...data.positions.map((position) => position.uavType),
    ]),
    crewReadiness: uniqueSorted(data.crews.map((crew) => crew.readiness)),
    positionReadiness: uniqueSorted(data.positions.map((position) => position.readiness)),
    assignmentStates: (["assigned", "crew-without-position", "position-without-crew"] as RegistryAssignmentState[])
      .filter((state) => states.has(state)),
  };
}
