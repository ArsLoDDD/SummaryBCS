import bcsSchema from "./shared/bcs-schema.json";

export type StructureType = "company" | "platoon" | "independent" | "custom";
export type BlockKind =
  | "companyManagement"
  | "platoonManagement"
  | "crew"
  | "department"
  | "informationDepartment"
  | "independent"
  | "attached"
  | "operationalSubordination"
  | "temporary"
  | "temporaryActing"
  | "unassigned"
  | "custom";

export interface StructureBlock {
  id: string;
  kind: BlockKind;
  name: string;
  positionName: string;
  slots: number;
  status: string;
  uavType: string;
  bro: string;
  workSector: string;
  uavName: string;
  crewActual: number;
}

export interface PersonInput {
  blockId: string;
  position: string;
  rank: string;
  fullName: string;
  duties: string;
  location: string;
  note: string;
}

export interface WorkspaceRequest {
  unitName: string;
  reportDate: string;
  structureType: StructureType;
  authorizedStrength: number;
  blocks: StructureBlock[];
  outputPath: string;
}

export interface EditorRequest extends WorkspaceRequest {
  people: PersonInput[];
}

export const STRUCTURE_TYPES: ReadonlyArray<{ value: StructureType; label: string }> = [
  { value: "company", label: "Рота" },
  { value: "platoon", label: "Взвод" },
];

export const BLOCK_TYPES: ReadonlyArray<{ value: BlockKind; label: string; shortLabel: string }> = [
  { value: "crew", label: "Екіпаж", shortLabel: "Екіпаж" },
  { value: "companyManagement", label: "Управління роти", shortLabel: "Управління роти" },
  { value: "platoonManagement", label: "Управління взводу", shortLabel: "Управління взводу" },
  { value: "department", label: "Відділення", shortLabel: "Відділення" },
  { value: "informationDepartment", label: "Відділення збору та обробки інформації", shortLabel: "Відділення інформації" },
  { value: "independent", label: "Окремий підрозділ", shortLabel: "Окремий" },
  { value: "custom", label: "Інші", shortLabel: "Інші" },
  { value: "attached", label: "Прикомандировані", shortLabel: "Прикомандировані" },
  { value: "operationalSubordination", label: "Оперативне підпорядкування", shortLabel: "Опер. підпорядкування" },
  { value: "temporary", label: "Тимчасово прибулі", shortLabel: "Тимчасові" },
  { value: "temporaryActing", label: "Тимчасові з ТВО", shortLabel: "Тимчасові з ТВО" },
  { value: "unassigned", label: "Не розподілені", shortLabel: "Не розподілені" },
];

export const QUICK_BLOCK_TYPES = BLOCK_TYPES.filter((item) =>
  item.value === "crew"
  || item.value === "companyManagement"
  || item.value === "platoonManagement"
  || item.value === "department"
  || item.value === "custom"
  || item.value === "attached"
  || item.value === "operationalSubordination"
  || item.value === "temporary"
  || item.value === "temporaryActing"
);

export function quickBlockTypesForStructure(structureType: StructureType) {
  return QUICK_BLOCK_TYPES.filter((item) => {
    if (structureType === "company") return item.value !== "companyManagement";
    if (structureType === "platoon") {
      return item.value !== "companyManagement" && item.value !== "platoonManagement";
    }
    return true;
  });
}

export const SINGLETON_BLOCK_KINDS: ReadonlyArray<BlockKind> = [
  "companyManagement",
  "platoonManagement",
  "custom",
];

export const CREW_STATUSES = ["Працюючий", "Формується", "Не активний"] as const;

export const UAV_TYPES = [
  "ФПВ",
  "ФПВ Перехоплювач",
  "Коптер",
  "Бомбер",
  "Літаковий Розвідувальний",
  "Літаковий Ударний",
  "НРК",
] as const;

export const LOCATIONS = bcsSchema.locations;
export const BCS_HEADERS = bcsSchema.headers;

export const RANKS = [
  "рекрут",
  "солдат",
  "старший солдат",
  "молодший сержант",
  "сержант",
  "старший сержант",
  "головний сержант",
  "штаб-сержант",
  "майстер-сержант",
  "старший майстер-сержант",
  "головний майстер-сержант",
  "молодший лейтенант",
  "лейтенант",
  "старший лейтенант",
  "капітан",
  "майор",
  "підполковник",
  "полковник",
] as const;

const DEFAULT_NAMES: Record<BlockKind, string> = {
  companyManagement: "Управління роти",
  platoonManagement: "Управління взводу",
  department: "Відділення",
  informationDepartment: "Відділення збору та обробки інформації",
  crew: "Екіпаж",
  independent: "Окремий підрозділ",
  attached: "Прикомандировані",
  operationalSubordination: "Оперативне підпорядкування",
  temporary: "Тимчасово прибулі",
  temporaryActing: "Тимчасові з ТВО",
  unassigned: "Не розподілені",
  custom: "Інші",
};

let nextBlockNumber = 1;

export function defaultBlockName(kind: BlockKind): string {
  return DEFAULT_NAMES[kind];
}

function uppercaseFirstLetter(value: string): string {
  return value.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase("uk-UA"));
}

export function formatBlockName(kind: BlockKind, value: string): string {
  return kind === "crew" ? value.toLocaleUpperCase("uk-UA") : uppercaseFirstLetter(value);
}

export function normalizeLegacyBlockName(kind: BlockKind, value: string): string {
  if (kind === "crew") return formatBlockName(kind, value);
  const letters = value.match(/\p{L}/gu) ?? [];
  const wasForcedUppercase = letters.length > 0
    && letters.every((letter) => letter === letter.toLocaleUpperCase("uk-UA"));
  return uppercaseFirstLetter(wasForcedUppercase ? value.toLocaleLowerCase("uk-UA") : value);
}

export function createBlock(kind: BlockKind): StructureBlock {
  const number = nextBlockNumber++;
  return {
    id: `block-${Date.now()}-${number}`,
    kind,
    name: formatBlockName(kind, defaultBlockName(kind)),
    positionName: "",
    slots: 1,
    status: kind === "crew" ? CREW_STATUSES[0] : "",
    uavType: kind === "crew" ? UAV_TYPES[0] : "",
    bro: "",
    workSector: "",
    uavName: "",
    crewActual: kind === "crew" ? 1 : 0,
  };
}

export function createDefaultCompanyBlocks(): StructureBlock[] {
  const crews = Array.from({ length: 6 }, (_, index) => ({
    ...createBlock("crew"),
    name: `ЕКІПАЖ ${index + 1}`,
  }));
  const department = createBlock("department");
  return [
    ...crews,
    createBlock("companyManagement"),
    createBlock("platoonManagement"),
    { ...department, name: "Відділення 1" },
    createBlock("custom"),
  ];
}

export function requiredManagementKind(structureType: StructureType): BlockKind | null {
  if (structureType === "company") return "companyManagement";
  if (structureType === "platoon") return "platoonManagement";
  return null;
}

export function isRequiredManagementBlock(structureType: StructureType, kind: BlockKind): boolean {
  return requiredManagementKind(structureType) === kind;
}

export function reconcileBlocksForStructure(
  structureType: StructureType,
  blocks: StructureBlock[],
): StructureBlock[] {
  let next = deduplicateSingletonBlocks(blocks);
  if (structureType === "platoon") {
    next = next.filter((block) => block.kind !== "companyManagement");
  }

  const requiredKind = requiredManagementKind(structureType);
  if (requiredKind && !next.some((block) => block.kind === requiredKind)) {
    next = [...next, createBlock(requiredKind)];
  }

  return sortBlocksByBcsOrder(withDefaultBlockNames(next));
}

const BLOCK_ORDER: Record<BlockKind, number> = {
  crew: 0,
  companyManagement: 1,
  platoonManagement: 2,
  department: 3,
  informationDepartment: 3,
  independent: 4,
  custom: 5,
  attached: 6,
  operationalSubordination: 7,
  temporary: 8,
  temporaryActing: 9,
  unassigned: 10,
};

export function sortBlocksByBcsOrder(blocks: StructureBlock[]): StructureBlock[] {
  return [...blocks].sort((left, right) => BLOCK_ORDER[left.kind] - BLOCK_ORDER[right.kind]);
}

export function isSingletonBlockKind(kind: BlockKind): boolean {
  return SINGLETON_BLOCK_KINDS.includes(kind);
}

export function deduplicateSingletonBlocks(blocks: StructureBlock[]): StructureBlock[] {
  const singletonIndexes = new Map<BlockKind, number>();
  const unique: StructureBlock[] = [];

  blocks.forEach((block) => {
    if (!isSingletonBlockKind(block.kind)) {
      unique.push(block);
      return;
    }

    const existingIndex = singletonIndexes.get(block.kind);
    if (existingIndex === undefined) {
      singletonIndexes.set(block.kind, unique.length);
      unique.push(block);
      return;
    }

    if (!unique[existingIndex].name.trim() && block.name.trim()) {
      unique[existingIndex] = block;
    }
  });

  return unique;
}

export function withDefaultBlockNames(blocks: StructureBlock[]): StructureBlock[] {
  return blocks.map((block) => ({
    ...block,
    name: block.name.trim() || defaultBlockName(block.kind),
  }));
}

export function totalSlots(blocks: StructureBlock[]): number {
  return blocks.reduce((total, block) => total + normalizedSlots(block.slots), 0);
}

export function normalizedSlots(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function formatReportDateForExport(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function capitalizeNamePart(value: string): string {
  return value
    .toLocaleLowerCase("uk-UA")
    .replace(/(^|[-'’.])([\p{L}])/gu, (_, separator: string, letter: string) =>
      `${separator}${letter.toLocaleUpperCase("uk-UA")}`,
    );
}

export function formatFullName(value: string): string {
  let surnameSeen = false;
  return (value.match(/\S+|\s+/gu) ?? []).map((part) => {
    if (/^\s+$/u.test(part)) return part;
    if (!surnameSeen) {
      surnameSeen = true;
      return part.toLocaleUpperCase("uk-UA");
    }
    return capitalizeNamePart(part);
  }).join("");
}

export function personKey(blockId: string, index: number): string {
  return `${blockId}:${index}`;
}

export function emptyPerson(blockId: string): PersonInput {
  return {
    blockId,
    position: "",
    rank: "",
    fullName: "",
    duties: "",
    location: "",
    note: "",
  };
}

export function personHasAnyData(person: PersonInput): boolean {
  return [
    person.position,
    person.rank,
    person.fullName,
    person.duties,
    person.location,
    person.note,
  ].some((value) => value.trim());
}

export function missingRequiredPersonFields(person: PersonInput): string[] {
  const missing: string[] = [];
  if (!person.rank.trim()) missing.push("Звання");
  if (!person.fullName.trim()) missing.push("П.І.Б.");
  if (!person.location.trim()) missing.push("Де знаходиться");
  return missing;
}

export function peopleForExport(
  blocks: StructureBlock[],
  peopleBySlot: Record<string, PersonInput>,
): PersonInput[] {
  return blocks.flatMap((block) =>
    Array.from({ length: normalizedSlots(block.slots) }, (_, index) =>
      peopleBySlot[personKey(block.id, index)] ?? emptyPerson(block.id),
    ),
  );
}

export function validateWorkspace(
  unitName: string,
  reportDate: string,
  structureType: StructureType,
  authorizedStrength: number,
  blocks: StructureBlock[],
): string {
  if (!unitName.trim()) return "Вкажіть назву підрозділу.";
  if (!reportDate) return "Вкажіть дату БЧС.";
  if (!Number.isInteger(authorizedStrength) || authorizedStrength < 1 || authorizedStrength > 20_000) {
    return "Кількість за штатом має бути цілим числом від 1 до 20 000.";
  }
  if (blocks.length === 0) return "Додайте хоча б один блок структури.";
  const requiredKind = requiredManagementKind(structureType);
  if (requiredKind && blocks.filter((block) => block.kind === requiredKind).length !== 1) {
    return structureType === "company"
      ? "Структура роти повинна містити одне управління роти."
      : "Структура взводу повинна містити одне управління взводу.";
  }
  if (structureType === "platoon" && blocks.some((block) => block.kind === "companyManagement")) {
    return "У структурі взводу не може бути управління роти.";
  }
  const unnamedBlockIndex = blocks.findIndex((block) => !block.name.trim());
  if (unnamedBlockIndex >= 0) {
    const block = blocks[unnamedBlockIndex];
    return `Вкажіть назву блоку №${unnamedBlockIndex + 1} (${defaultBlockName(block.kind)}).`;
  }
  if (blocks.length > 2_000) return "У структурі може бути не більше 2 000 блоків.";
  if (blocks.some((block) => !Number.isInteger(block.slots) || block.slots < 1 || block.slots > 2_000)) {
    return "У кожному блоці має бути від 1 до 2 000 місць.";
  }
  if (totalSlots(blocks) > 20_000) {
    return "Загальна кількість рядків у структурі не може перевищувати 20 000.";
  }
  if (blocks.some((block) => block.kind === "crew" && !CREW_STATUSES.some((status) => status === block.status))) {
    return "Оберіть статус для кожного екіпажу.";
  }
  if (blocks.some((block) => block.kind === "crew" && !UAV_TYPES.some((type) => type === block.uavType))) {
    return "Оберіть тип БпАК для кожного екіпажу.";
  }
  if (blocks.some((block) => block.kind === "crew"
    && (!Number.isInteger(block.crewActual) || block.crewActual < 0 || block.crewActual > 2_000))) {
    return "Фактична кількість осіб у кожному екіпажі має бути цілим числом від 0 до 2 000.";
  }
  if (SINGLETON_BLOCK_KINDS.some((kind) => blocks.filter((block) => block.kind === kind).length > 1)) {
    return "Управління роти, управління взводу та блок «Інші» можна додати лише по одному.";
  }
  return "";
}
