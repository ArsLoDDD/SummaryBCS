import { normalizeEditorData, type BcsEditorData, type BcsPosition } from "./bcsEditorData";
import {
  BLOCK_TYPES, CREW_STATUSES, STRUCTURE_TYPES, UAV_TYPES, defaultBlockName,
  isSingletonBlockKind, normalizeLegacyBlockName, reconcileBlocksForStructure,
  type BlockKind, type PersonInput, type StructureBlock, type StructureType,
} from "./structure";

export interface WorkspaceDraft {
  version: 1;
  unitName: string;
  reportDate: string;
  structureType: StructureType;
  authorizedStrength: number;
  blocks: StructureBlock[];
  peopleBySlot: Record<string, PersonInput>;
  positions?: BcsPosition[];
  positionByBlock?: Record<string, string>;
  importWarnings?: string[];
}

export interface RestoredWorkspace {
  draft: WorkspaceDraft;
  data: BcsEditorData;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One restore path for encrypted drafts and imported BCS files. Invalid drafts must never autosave defaults. */
export function restoreWorkspaceDraft(value: unknown): RestoredWorkspace | null {
  const raw = record(value);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.blocks) || raw.blocks.length === 0) return null;
  if (typeof raw.unitName !== "string" || typeof raw.reportDate !== "string"
    || typeof raw.authorizedStrength !== "number" || !Number.isFinite(raw.authorizedStrength)) return null;
  const knownKinds = new Set(BLOCK_TYPES.map((item) => item.value));
  const seenIds = new Set<string>();
  const blocks: StructureBlock[] = [];
  for (const value of raw.blocks) {
    const block = record(value);
    if (!block || typeof block.id !== "string" || !block.id || seenIds.has(block.id)
      || typeof block.kind !== "string" || !knownKinds.has(block.kind as BlockKind)) return null;
    seenIds.add(block.id);
    const kind = block.kind as BlockKind;
    const slots = typeof block.slots === "number" ? block.slots : 1;
    if (!Number.isInteger(slots) || slots < 1 || slots > 2_000) return null;
    blocks.push({
      id: block.id, kind,
      name: normalizeLegacyBlockName(kind, stringValue(block.name)) || defaultBlockName(kind),
      positionName: stringValue(block.positionName), slots,
      status: typeof block.status === "string" ? block.status : kind === "crew" ? CREW_STATUSES[0] : "",
      uavType: typeof block.uavType === "string" ? block.uavType : kind === "crew" ? UAV_TYPES[0] : "",
      bro: stringValue(block.bro), workSector: stringValue(block.workSector), uavName: stringValue(block.uavName),
      crewActual: typeof block.crewActual === "number" ? block.crewActual : kind === "crew" ? slots : 0,
    });
  }
  const people = record(raw.peopleBySlot);
  if (!people) return null;
  const peopleBySlot: Record<string, PersonInput> = {};
  for (const [key, value] of Object.entries(people)) {
    const person = record(value);
    if (!person) return null;
    peopleBySlot[key] = {
      blockId: stringValue(person.blockId), position: stringValue(person.position),
      rank: stringValue(person.rank), fullName: stringValue(person.fullName),
      duties: stringValue(person.duties), location: stringValue(person.location), note: stringValue(person.note),
    };
  }
  if (raw.positions !== undefined && (!Array.isArray(raw.positions) || raw.positions.some((value) => {
    const position = record(value);
    return !position || !["id", "name", "bro", "workSector"].every((key) => typeof position[key] === "string");
  }))) return null;
  if (raw.positionByBlock !== undefined && !record(raw.positionByBlock)) return null;
  const structureType = STRUCTURE_TYPES.some((type) => type.value === raw.structureType)
    ? raw.structureType as StructureType : "company";
  const importWarnings = Array.isArray(raw.importWarnings)
    ? raw.importWarnings.filter((warning): warning is string => typeof warning === "string") : [];
  const seenSingletons = new Set<BlockKind>();
  // Reconciliation removes invalid management blocks and duplicate singletons.
  // Keep legacy records intact instead: the user can redistribute them explicitly.
  const preservedBlocks: StructureBlock[] = blocks.map((block, index) => {
    const incompatibleManagement = structureType === "platoon" && block.kind === "companyManagement";
    const duplicateSingleton = isSingletonBlockKind(block.kind) && seenSingletons.has(block.kind);
    if (isSingletonBlockKind(block.kind)) seenSingletons.add(block.kind);
    if (!incompatibleManagement && !duplicateSingleton) return block;
    const reason = incompatibleManagement ? "Управління роти у структурі взводу" : "Повторний одиничний блок";
    importWarnings.push(`${reason} «${block.name}» (блок ${index + 1}) збережено як «Не розподілені». Усі місця, люди та дані позиції залишено; перевірте тип підрозділу у вкладці «Дані».`);
    return { ...block, kind: "unassigned" };
  });
  const data = normalizeEditorData(
    reconcileBlocksForStructure(structureType, preservedBlocks), peopleBySlot, raw.positions, raw.positionByBlock,
  );
  const draft: WorkspaceDraft = {
    version: 1, unitName: raw.unitName, reportDate: raw.reportDate, structureType,
    authorizedStrength: raw.authorizedStrength, ...data, importWarnings,
  };
  return { draft, data };
}
