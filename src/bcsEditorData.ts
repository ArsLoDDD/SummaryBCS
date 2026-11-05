import {
  CREW_STATUSES,
  UAV_TYPES,
  createBlock,
  emptyPerson,
  formatBlockName,
  formatFullName,
  normalizeLegacyBlockName,
  normalizedSlots,
  personHasAnyData,
  personKey,
  sortBlocksByBcsOrder,
  type PersonInput,
  type StructureBlock,
} from "./structure";

export interface BcsPosition {
  id: string;
  name: string;
  bro: string;
  workSector: string;
}

export interface BcsEditorData {
  blocks: StructureBlock[];
  peopleBySlot: Record<string, PersonInput>;
  positions: BcsPosition[];
  positionByBlock: Record<string, string>;
}

export interface EditorPersonnelRow {
  key: string;
  block: StructureBlock;
  index: number;
  person: PersonInput;
}

let nextPositionNumber = 1;

export function createEditorPosition(): BcsPosition {
  return { id: `position-${Date.now()}-${nextPositionNumber++}`, name: "", bro: "", workSector: "" };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function uppercase(value: unknown): string {
  return text(value).toLocaleUpperCase("uk-UA");
}

function normalizedPosition(position: BcsPosition): BcsPosition {
  return {
    id: position.id,
    name: uppercase(position.name),
    bro: uppercase(position.bro),
    workSector: uppercase(position.workSector),
  };
}

function normalizedPerson(person: Partial<PersonInput> | undefined, blockId: string): PersonInput {
  return {
    blockId,
    position: text(person?.position),
    rank: text(person?.rank),
    fullName: formatFullName(text(person?.fullName)),
    duties: text(person?.duties),
    location: text(person?.location),
    note: text(person?.note),
  };
}

function positionTuple(position: Omit<BcsPosition, "id">): string {
  return JSON.stringify([position.name.trim(), position.bro.trim(), position.workSector.trim()]);
}

function positionForBlock(block: StructureBlock): Omit<BcsPosition, "id"> {
  return { name: uppercase(block.positionName), bro: uppercase(block.bro), workSector: uppercase(block.workSector) };
}

function hasPositionData(position: Omit<BcsPosition, "id">): boolean {
  return [position.name, position.bro, position.workSector].some((value) => value.trim());
}

function projectPositions(data: BcsEditorData): BcsEditorData {
  const positionsById = new Map(data.positions.map((position) => [position.id, position]));
  return {
    ...data,
    blocks: data.blocks.map((block) => {
      const position = positionsById.get(data.positionByBlock[block.id]);
      return position
        ? { ...block, positionName: position.name, bro: position.bro, workSector: position.workSector }
        : block;
    }),
  };
}

/** Migrate saved table-only drafts while retaining the same canonical export fields. */
export function normalizeEditorData(
  blocks: StructureBlock[],
  peopleBySlot: Record<string, PersonInput>,
  rawPositions?: unknown,
  rawLinks?: unknown,
): BcsEditorData {
  const positions: BcsPosition[] = [];
  const usedIds = new Set<string>();
  if (Array.isArray(rawPositions)) {
    for (const candidate of rawPositions) {
      if (!candidate || typeof candidate !== "object") continue;
      const raw = candidate as Partial<BcsPosition>;
      const id = text(raw.id).trim();
      if (!id || usedIds.has(id)) continue;
      usedIds.add(id);
      positions.push(normalizedPosition({ id, name: text(raw.name), bro: text(raw.bro), workSector: text(raw.workSector) }));
    }
  }
  const links = rawLinks && typeof rawLinks === "object" && !Array.isArray(rawLinks)
    ? rawLinks as Record<string, unknown>
    : {};
  const positionByBlock: Record<string, string> = {};
  const normalizedPeople = { ...peopleBySlot };
  const normalizedBlocks = blocks.map((block) => {
    let slots = Math.max(1, normalizedSlots(block.slots));
    // Older versions could leave populated tail rows hidden after reducing a block.
    for (const [key, person] of Object.entries(peopleBySlot)) {
      if (!key.startsWith(`${block.id}:`)) continue;
      const suffix = key.slice(block.id.length + 1);
      if (!/^\d+$/u.test(suffix)) continue;
      const index = Number(suffix);
      if (!Number.isSafeInteger(index)) continue;
      const normalized = normalizedPerson(person, block.id);
      normalizedPeople[key] = normalized;
      if (personHasAnyData(normalized)) slots = Math.max(slots, index + 1);
    }
    const next = {
      ...block,
      name: normalizeLegacyBlockName(block.kind, block.name),
      slots,
      positionName: uppercase(block.positionName),
      bro: uppercase(block.bro),
      workSector: uppercase(block.workSector),
    };
    const linkedId = text(links[block.id]);
    if (usedIds.has(linkedId)) {
      positionByBlock[block.id] = linkedId;
      return next;
    }
    const legacyPosition = positionForBlock(next);
    if (!hasPositionData(legacyPosition)) return next;
    const tuple = positionTuple(legacyPosition);
    let position = positions.find((item) => positionTuple(item) === tuple);
    if (!position) {
      const created = createEditorPosition();
      let id = `position-legacy-${block.id}`;
      while (usedIds.has(id)) id = created.id + `-${nextPositionNumber++}`;
      position = { id, ...legacyPosition };
      positions.push(position);
      usedIds.add(id);
    }
    positionByBlock[block.id] = position.id;
    return next;
  });
  const blockIds = new Set(normalizedBlocks.map((block) => block.id));
  const orphanPeople = Object.entries(normalizedPeople).filter(([key]) => {
    const separator = key.lastIndexOf(":");
    const suffix = key.slice(separator + 1);
    return separator < 0 || !/^\d+$/u.test(suffix) || !Number.isSafeInteger(Number(suffix))
      || !blockIds.has(key.slice(0, separator));
  });
  for (const [key, rawPerson] of orphanPeople) {
    delete normalizedPeople[key];
    const person = normalizedPerson(rawPerson, "");
    if (!personHasAnyData(person)) continue;
    let unassignedIndex = normalizedBlocks.findIndex((block) => block.kind === "unassigned");
    if (unassignedIndex < 0) {
      normalizedBlocks.push(createBlock("unassigned"));
      unassignedIndex = normalizedBlocks.length - 1;
    }
    const unassigned = normalizedBlocks[unassignedIndex];
    let index = 0;
    while (index < unassigned.slots
      && personHasAnyData(normalizedPeople[personKey(unassigned.id, index)] ?? emptyPerson(unassigned.id))) index++;
    normalizedPeople[personKey(unassigned.id, index)] = { ...person, blockId: unassigned.id };
    if (index >= unassigned.slots) normalizedBlocks[unassignedIndex] = { ...unassigned, slots: index + 1 };
  }
  return projectPositions({ blocks: sortBlocksByBcsOrder(normalizedBlocks), peopleBySlot: normalizedPeople, positions, positionByBlock });
}

function requireBlock(data: BcsEditorData, blockId: string): StructureBlock {
  const block = data.blocks.find((item) => item.id === blockId);
  if (!block) throw new Error("Підрозділ не знайдено. Оновіть дані та спробуйте ще раз.");
  return block;
}

function requirePersonIndex(block: StructureBlock, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= normalizedSlots(block.slots)) {
    throw new Error("Місце військовослужбовця не знайдено.");
  }
}

function requireSlotCapacity(data: BcsEditorData, blockId: string, slots: number): void {
  if (!Number.isInteger(slots) || slots < 1 || slots > 2_000) {
    throw new Error("У кожному підрозділі має бути від 1 до 2 000 місць цілим числом.");
  }
  const total = data.blocks.reduce((sum, block) => sum + (block.id === blockId ? slots : normalizedSlots(block.slots)), 0);
  if (total > 20_000) throw new Error("Загальна кількість місць не може перевищувати 20 000.");
}

function peopleWithoutBlock(data: BcsEditorData, blockId: string): Record<string, PersonInput> {
  return Object.fromEntries(Object.entries(data.peopleBySlot).filter(([key]) => !key.startsWith(`${blockId}:`)));
}

export function editorPersonnelRows(data: BcsEditorData): EditorPersonnelRow[] {
  return data.blocks.flatMap((block) => Array.from({ length: normalizedSlots(block.slots) }, (_, index) => {
    const key = personKey(block.id, index);
    return { key, block, index, person: data.peopleBySlot[key] ?? emptyPerson(block.id) };
  }));
}

export function updateEditorBlock(data: BcsEditorData, id: string, patch: Partial<StructureBlock>): BcsEditorData {
  const block = requireBlock(data, id);
  const slots = patch.slots ?? block.slots;
  if (patch.slots !== undefined) requireSlotCapacity(data, id, slots);
  if (slots < block.slots) {
    const populatedTail = Object.entries(data.peopleBySlot).some(([key, person]) => {
      if (!key.startsWith(`${id}:`)) return false;
      const index = Number(key.slice(id.length + 1));
      return Number.isInteger(index) && index >= slots && personHasAnyData(person);
    });
    if (populatedTail) {
      throw new Error("Не можна зменшити кількість місць: у рядках, що будуть прибрані, є дані. Спочатку перемістіть або видаліть цих військовослужбовців.");
    }
  }
  const nextBlock = { ...block, ...patch, id, slots };
  nextBlock.name = formatBlockName(nextBlock.kind, nextBlock.name);
  nextBlock.positionName = uppercase(nextBlock.positionName);
  nextBlock.bro = uppercase(nextBlock.bro);
  nextBlock.workSector = uppercase(nextBlock.workSector);
  if (nextBlock.kind !== block.kind) {
    if (nextBlock.kind === "crew") {
      nextBlock.status = patch.status ?? CREW_STATUSES[0];
      nextBlock.uavType = patch.uavType ?? UAV_TYPES[0];
      nextBlock.uavName = patch.uavName ?? "";
      nextBlock.crewActual = patch.crewActual ?? normalizedSlots(block.slots);
    } else {
      nextBlock.status = "";
      nextBlock.uavType = "";
      nextBlock.uavName = "";
      nextBlock.crewActual = 0;
    }
  }
  const blocks = data.blocks.map((item) => item.id === id ? nextBlock : item);
  let next: BcsEditorData = { ...data, blocks: nextBlock.kind === block.kind ? blocks : sortBlocksByBcsOrder(blocks) };
  if (slots < block.slots) {
    next = { ...next, peopleBySlot: Object.fromEntries(Object.entries(data.peopleBySlot).filter(([key]) => {
      if (!key.startsWith(`${id}:`)) return true;
      return Number(key.slice(id.length + 1)) < slots;
    })) };
  }
  if (patch.positionName === undefined && patch.bro === undefined && patch.workSector === undefined) return next;
  const positionId = data.positionByBlock[id];
  if (positionId && data.positions.some((position) => position.id === positionId)) {
    return projectPositions({ ...next, positions: data.positions.map((position) => position.id === positionId
      ? { id: positionId, ...positionForBlock(nextBlock) }
      : position) });
  }
  if (!hasPositionData(positionForBlock(nextBlock))) return next;
  // Typing matching text does not imply a shared position; only the explicit picker links live records.
  const position = { ...createEditorPosition(), ...positionForBlock(nextBlock) };
  next = {
    ...next,
    positions: [...data.positions, position],
    positionByBlock: { ...data.positionByBlock, [id]: position.id },
  };
  return projectPositions(next);
}

export function setEditorBlockPosition(data: BcsEditorData, blockId: string, positionId: string | null): BcsEditorData {
  requireBlock(data, blockId);
  const positionByBlock = { ...data.positionByBlock };
  if (positionId === null) {
    delete positionByBlock[blockId];
    return {
      ...data,
      positionByBlock,
      blocks: data.blocks.map((block) => block.id === blockId ? { ...block, positionName: "", bro: "", workSector: "" } : block),
    };
  }
  if (!data.positions.some((position) => position.id === positionId)) throw new Error("Позицію не знайдено.");
  positionByBlock[blockId] = positionId;
  return projectPositions({ ...data, positionByBlock });
}

export function saveEditorPosition(data: BcsEditorData, position: BcsPosition): BcsEditorData {
  const next = normalizedPosition(position);
  if (!next.id.trim()) throw new Error("Не вдалося зберегти позицію: відсутній ідентифікатор.");
  const exists = data.positions.some((item) => item.id === next.id);
  return projectPositions({
    ...data,
    positions: exists ? data.positions.map((item) => item.id === next.id ? next : item) : [...data.positions, next],
  });
}

export function removeEditorPosition(data: BcsEditorData, id: string): BcsEditorData {
  const detachedBlockIds = new Set(Object.keys(data.positionByBlock).filter((blockId) => data.positionByBlock[blockId] === id));
  return {
    ...data,
    positions: data.positions.filter((position) => position.id !== id),
    positionByBlock: Object.fromEntries(Object.entries(data.positionByBlock).filter(([, positionId]) => positionId !== id)),
    blocks: data.blocks.map((block) => detachedBlockIds.has(block.id) ? { ...block, positionName: "", bro: "", workSector: "" } : block),
  };
}

export function updateEditorPerson(
  data: BcsEditorData,
  blockId: string,
  index: number,
  patch: Partial<PersonInput>,
): BcsEditorData {
  const block = requireBlock(data, blockId);
  requirePersonIndex(block, index);
  const key = personKey(blockId, index);
  return {
    ...data,
    peopleBySlot: { ...data.peopleBySlot, [key]: normalizedPerson({ ...data.peopleBySlot[key], ...patch }, blockId) },
  };
}

export function addEditorPerson(data: BcsEditorData, blockId: string): BcsEditorData {
  const block = requireBlock(data, blockId);
  for (let index = 0; index < normalizedSlots(block.slots); index++) {
    if (!personHasAnyData(data.peopleBySlot[personKey(blockId, index)] ?? emptyPerson(blockId))) return data;
  }
  requireSlotCapacity(data, blockId, block.slots + 1);
  return { ...data, blocks: data.blocks.map((item) => item.id === blockId ? { ...item, slots: item.slots + 1 } : item) };
}

export function removeEditorPerson(data: BcsEditorData, blockId: string, index: number): BcsEditorData {
  const block = requireBlock(data, blockId);
  requirePersonIndex(block, index);
  const peopleBySlot = peopleWithoutBlock(data, blockId);
  let targetIndex = 0;
  for (let sourceIndex = 0; sourceIndex < normalizedSlots(block.slots); sourceIndex++) {
    if (sourceIndex === index) continue;
    const person = data.peopleBySlot[personKey(blockId, sourceIndex)];
    if (person) peopleBySlot[personKey(blockId, targetIndex)] = { ...person, blockId };
    targetIndex++;
  }
  return {
    ...data,
    peopleBySlot,
    blocks: data.blocks.map((item) => item.id === blockId ? { ...item, slots: Math.max(1, item.slots - 1) } : item),
  };
}

export function moveEditorPerson(data: BcsEditorData, sourceBlockId: string, sourceIndex: number, targetBlockId: string): BcsEditorData {
  const sourceBlock = requireBlock(data, sourceBlockId);
  const targetBlock = requireBlock(data, targetBlockId);
  requirePersonIndex(sourceBlock, sourceIndex);
  if (sourceBlockId === targetBlockId) return data;
  const person = data.peopleBySlot[personKey(sourceBlockId, sourceIndex)] ?? emptyPerson(sourceBlockId);
  if (!personHasAnyData(person)) throw new Error("Спочатку заповніть дані військовослужбовця.");
  let targetIndex = 0;
  while (targetIndex < normalizedSlots(targetBlock.slots)
    && personHasAnyData(data.peopleBySlot[personKey(targetBlockId, targetIndex)] ?? emptyPerson(targetBlockId))) targetIndex++;
  if (targetIndex >= 2_000) throw new Error("У цільовому підрозділі вже є 2 000 місць. Спочатку звільніть місце.");
  const next = removeEditorPerson(data, sourceBlockId, sourceIndex);
  requireSlotCapacity(next, targetBlockId, Math.max(targetBlock.slots, targetIndex + 1));
  return {
    ...next,
    blocks: next.blocks.map((block) => block.id === targetBlockId
      ? { ...block, slots: Math.max(block.slots, targetIndex + 1) }
      : block),
    peopleBySlot: { ...next.peopleBySlot, [personKey(targetBlockId, targetIndex)]: { ...person, blockId: targetBlockId } },
  };
}

/** The caller confirms deletion and guards required management blocks. */
export function removeEditorBlock(data: BcsEditorData, id: string): BcsEditorData {
  const positionByBlock = { ...data.positionByBlock };
  delete positionByBlock[id];
  return {
    ...data,
    blocks: data.blocks.filter((block) => block.id !== id),
    peopleBySlot: peopleWithoutBlock(data, id),
    positionByBlock,
  };
}
