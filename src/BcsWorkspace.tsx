import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronUp, Download, LoaderCircle, Minus, Plus, Trash2, Users } from "lucide-react";
import CustomSelect, { type CustomSelectOption } from "./CustomSelect";
import { crewTypeSummaryRows } from "./bcsSummary";
import {
  BCS_HEADERS,
  BLOCK_TYPES,
  CREW_STATUSES,
  LOCATIONS,
  RANKS,
  STRUCTURE_TYPES,
  UAV_TYPES,
  createBlock,
  createDefaultCompanyBlocks,
  deduplicateSingletonBlocks,
  defaultBlockName,
  emptyPerson,
  formatFullName,
  formatReportDateForExport,
  isSingletonBlockKind,
  isRequiredManagementBlock,
  missingRequiredPersonFields,
  normalizedSlots,
  peopleForExport,
  personHasAnyData,
  personKey,
  quickBlockTypesForStructure,
  reconcileBlocksForStructure,
  sortBlocksByBcsOrder,
  totalSlots,
  validateWorkspace,
  withDefaultBlockNames,
  type BlockKind,
  type PersonInput,
  type StructureBlock,
  type StructureType,
} from "./structure";

interface Props {
  variant: "template" | "editor";
}

interface WorkspaceDraft {
  version: 1;
  unitName: string;
  reportDate: string;
  structureType: StructureType;
  authorizedStrength: number;
  blocks: StructureBlock[];
  peopleBySlot: Record<string, PersonInput>;
}

function tomorrow(): string {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function messageFrom(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Не вдалося створити файл.";
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ") || "Підрозділ";
}

function upper(value: string): string {
  return value.toLocaleUpperCase("uk-UA");
}

function formatDateForSheet(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

interface NumberStepperProps {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function NumberStepper({ ariaLabel, value, min, max, onChange }: NumberStepperProps) {
  const apply = (next: number) => onChange(Math.min(max, Math.max(min, Math.trunc(next))));

  return (
    <div className="number-stepper">
      <input
        aria-label={ariaLabel}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "");
          apply(digits ? Number(digits) : min);
        }}
      />
      <div className="number-stepper-controls">
        <button
          type="button"
          className="number-stepper-button"
          aria-label={`Збільшити: ${ariaLabel}`}
          disabled={value >= max}
          onClick={() => apply(value + 1)}
        >
          <ChevronUp size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="number-stepper-button"
          aria-label={`Зменшити: ${ariaLabel}`}
          disabled={value <= min}
          onClick={() => apply(value - 1)}
        >
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const ABSENT_LOCATIONS = new Set(["ВІДП", "ЛІК", "ВЛК", "НАВЧ", "ВІДР", "Відкомандировані", "СЗЧ", "ПТЗ Новостав"]);
const SUMMARY_UAV_TYPES = [
  "Бомбер",
  "Коптер",
  "Літаковий Розвідувальний",
  "Літаковий Ударний",
  "НРК",
  "ФПВ",
  "ФПВ Перехоплювач",
] as const;
const TABLE_ZOOM_STEPS = [50, 60, 70, 80, 90, 100, 110, 125] as const;
type CrewStatusGroup = "forming" | "working" | "inactive";

function crewStatusGroup(status: string): CrewStatusGroup {
  const normalized = upper(status).replace(/\s+/g, "");
  if (normalized.startsWith("ФОРМ")) return "forming";
  if (normalized.startsWith("ПРАЦ") || normalized === "АКТИВНИЙ") return "working";
  return "inactive";
}

function isExternalBlockKind(kind: BlockKind): boolean {
  return kind === "attached" || kind === "operationalSubordination" || kind === "temporary";
}

function statusClass(status: string): string {
  if (status === "Працюючий") return "status-working";
  if (status === "Формується") return "status-forming";
  if (status === "Не активний") return "status-inactive";
  return "";
}

function blockTypeLabel(kind: BlockKind): string {
  return BLOCK_TYPES.find((item) => item.value === kind)?.label ?? "Блок";
}

function blockNameLabel(kind: BlockKind): string {
  if (kind === "crew") return "Назва екіпажу";
  if (kind === "department" || kind === "informationDepartment") return "Назва відділення";
  return "Назва блоку";
}

function blockNamePlaceholder(kind: BlockKind): string {
  if (kind === "crew") return "Введіть назву екіпажу";
  if (kind === "department" || kind === "informationDepartment") return "Введіть назву відділення";
  return "Введіть назву";
}

function blockNameIsSection(kind: BlockKind): boolean {
  return kind === "department"
    || kind === "informationDepartment"
    || kind === "independent"
    || kind === "custom";
}

function blockTableClass(kind: BlockKind): string {
  if (kind === "companyManagement") return "block-company-management";
  if (kind === "platoonManagement") return "block-platoon-management";
  if (kind === "attached") return "block-attached";
  if (kind === "operationalSubordination") return "block-operational";
  if (kind === "temporary") return "block-temporary";
  if (kind === "unassigned") return "block-unassigned";
  return "block-section";
}

function sectionForBlock(block: StructureBlock): string {
  if (block.kind === "companyManagement") return "Управління роти";
  if (block.kind === "platoonManagement") return "Управління взводу";
  if (block.kind === "crew") return "Екіпаж";
  if (block.kind === "attached") return "Прикомандировані";
  if (block.kind === "operationalSubordination") return "Оперативне підпорядкування";
  if (block.kind === "temporary") return "Тимчасово прибулі";
  if (block.kind === "unassigned") return "Не розподілені";
  return block.name.trim() || blockTypeLabel(block.kind);
}

function BcsColGroup() {
  return (
    <colgroup>
      <col className="bcs-col-section" />
      <col className="bcs-col-position-name" />
      <col className="bcs-col-bro" />
      <col className="bcs-col-sector" />
      <col className="bcs-col-crew-name" />
      <col className="bcs-col-actual" />
      <col className="bcs-col-official" />
      <col className="bcs-col-status" />
      <col className="bcs-col-uav-name" />
      <col className="bcs-col-uav-type" />
      <col className="bcs-col-position" />
      <col className="bcs-col-rank" />
      <col className="bcs-col-name" />
      <col className="bcs-col-duties" />
      <col className="bcs-col-location" />
      <col className="bcs-col-note" />
    </colgroup>
  );
}

function normalizeLoadedBlocks(value: unknown): StructureBlock[] | null {
  if (!Array.isArray(value)) return null;
  const knownKinds = new Set(BLOCK_TYPES.map((item) => item.value));
  const blocks = value.filter((item): item is Partial<StructureBlock> & { id: string; kind: BlockKind } => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<StructureBlock>;
    return typeof candidate.id === "string"
      && typeof candidate.kind === "string"
      && knownKinds.has(candidate.kind as BlockKind);
  });
  if (blocks.length !== value.length || blocks.length === 0) return null;
  const normalized = blocks.map((block) => ({
    id: block.id,
    kind: block.kind,
    name: typeof block.name === "string" ? block.name : "",
    positionName: typeof block.positionName === "string" ? block.positionName : "",
    slots: typeof block.slots === "number" ? block.slots : 1,
    status: typeof block.status === "string" && block.status
      ? block.status
      : block.kind === "crew" ? CREW_STATUSES[0] : "",
    uavType: typeof block.uavType === "string" && block.uavType
      ? block.uavType
      : block.kind === "crew" ? UAV_TYPES[0] : "",
    bro: typeof block.bro === "string" ? block.bro : "",
    workSector: typeof block.workSector === "string" ? block.workSector : "",
    uavName: typeof block.uavName === "string" ? block.uavName : "",
    crewActual: typeof block.crewActual === "number"
      ? block.crewActual
      : block.kind === "crew" ? normalizedSlots(block.slots ?? 1) : 0,
  }));
  return sortBlocksByBcsOrder(withDefaultBlockNames(deduplicateSingletonBlocks(normalized)));
}

export default function BcsWorkspace({ variant }: Props) {
  const isEditor = variant === "editor";
  const [unitName, setUnitName] = useState("");
  const [reportDate, setReportDate] = useState(tomorrow);
  const [structureType, setStructureType] = useState<StructureType>("company");
  const [authorizedStrength, setAuthorizedStrength] = useState(10);
  const [blocks, setBlocks] = useState<StructureBlock[]>(createDefaultCompanyBlocks);
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(() => new Set());
  const [peopleBySlot, setPeopleBySlot] = useState<Record<string, PersonInput>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [donePath, setDonePath] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saved" | "saving" | "error">("saved");
  const [tableZoom, setTableZoom] = useState(80);

  const places = useMemo(() => totalSlots(blocks), [blocks]);
  const people = useMemo(() => peopleForExport(blocks, peopleBySlot), [blocks, peopleBySlot]);
  const exportBlocks = useMemo(() => withDefaultBlockNames(blocks), [blocks]);
  const workspaceValidationError = validateWorkspace(
    unitName,
    reportDate,
    structureType,
    authorizedStrength,
    exportBlocks,
  );
  const missingPersonFields = useMemo(() => {
    const missing = new Set<string>();
    if (isEditor) {
      people.forEach((person) => {
        missingRequiredPersonFields(person).forEach((field) => missing.add(field));
      });
    }
    return [...missing];
  }, [isEditor, people]);
  const personValidationError = missingPersonFields.length > 0
    ? `Для кожної заповненої людини вкажіть: ${missingPersonFields.join(", ")}.`
    : "";
  const exportUnavailableReason = workspaceValidationError || personValidationError;
  const sheetSummary = useMemo(() => {
    const populated = blocks.flatMap((block) =>
      Array.from({ length: normalizedSlots(block.slots) }, (_, index) => ({
        block,
        person: peopleBySlot[personKey(block.id, index)] ?? emptyPerson(block.id),
      })),
    ).filter(({ person }) => person.fullName.trim());
    const isOwn = (block: StructureBlock) => !isExternalBlockKind(block.kind);
    const isTemporaryActing = (block: StructureBlock, person: PersonInput) =>
      block.kind === "temporary" && upper(person.position).includes("ТВО");
    const countOwnLocation = (location: string) => populated.filter(({ block, person }) =>
      isOwn(block) && person.location === location,
    ).length;
    const countAllLocation = (location: string) => populated.filter(({ person }) => person.location === location).length;
    const byList = populated.filter(({ block, person }) =>
      isOwn(block) || isTemporaryActing(block, person),
    ).length;
    const present = populated.filter(({ block, person }) =>
      isOwn(block) && !ABSENT_LOCATIONS.has(person.location),
    ).length;

    const main: Array<[string, number]> = [
      ["По штату", authorizedStrength],
      ["По списку", byList],
      ["В наявності", present],
      ["Відпустка", countOwnLocation("ВІДП")],
      ["Шпиталь", countOwnLocation("ЛІК") + countOwnLocation("ВЛК")],
      ["Відрядження", countOwnLocation("НАВЧ") + countOwnLocation("ВІДР")],
      ["Відкомандировані", countOwnLocation("Відкомандировані")],
      ["Прикомандировані", populated.filter(({ block }) => block.kind === "attached").length],
      ["Оперативне підпорядкування", populated.filter(({ block }) => block.kind === "operationalSubordination").length],
      ["ПТЗ Новостав", countOwnLocation("ПТЗ Новостав")],
      ["СЗЧ", countOwnLocation("СЗЧ")],
      ["Тимчасово прибулі", populated.filter(({ block }) => block.kind === "temporary").length],
      ["Тимчасово прибулі з ТВО", populated.filter(({ block, person }) => isTemporaryActing(block, person)).length],
    ];

    const crews = blocks.filter((block) => block.kind === "crew");
    const uniqueCrewPersonnel = new Set(
      populated
        .filter(({ block }) => block.kind === "crew")
        .map(({ person }) => upper(person.fullName).trim()),
    ).size;
    const functional: Array<[string, number]> = [
      ["Екіпажів (ос-загально)", uniqueCrewPersonnel],
      ["Екіпажів (загально)", crews.length],
      ...crewTypeSummaryRows(crews, SUMMARY_UAV_TYPES),
      ["Екіпажів — Формуються", crews.filter((block) => crewStatusGroup(block.status) === "forming").length],
      ["Екіпажів — Працюючі", crews.filter((block) => crewStatusGroup(block.status) === "working").length],
      ["Екіпажів — Не активні", crews.filter((block) => crewStatusGroup(block.status) === "inactive").length],
    ];
    const seenSections = new Set<string>();
    blocks.forEach((block) => {
      if (block.kind === "crew" || isExternalBlockKind(block.kind)) return;
      const section = sectionForBlock(block);
      if (seenSections.has(section)) return;
      seenSections.add(section);
      functional.push([
        section,
        populated.filter(({ block: candidate, person }) =>
          sectionForBlock(candidate) === section && !ABSENT_LOCATIONS.has(person.location),
        ).length,
      ]);
    });

    const locations: Array<[string, number]> = LOCATIONS.map((location) => [location, countAllLocation(location)]);
    locations.push([
      "Не вказано / інше",
      populated.filter(({ person }) => !person.location || !LOCATIONS.includes(person.location)).length,
    ]);
    locations.push(["Загалом", populated.length]);

    return {
      main,
      functional,
      locations,
      rowCount: Math.max(main.length, functional.length, locations.length),
    };
  }, [authorizedStrength, blocks, peopleBySlot]);
  const tauriAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const notification = error
    ? { kind: "error", text: error }
    : donePath
      ? { kind: "success", text: `Файл збережено: ${donePath}` }
      : draftStatus === "error"
        ? { kind: "error", text: "Не вдалося зберегти чернетку." }
        : null;

  const structureOptions = STRUCTURE_TYPES as ReadonlyArray<CustomSelectOption<StructureType>>;
  const statusOptions = CREW_STATUSES.map((value) => ({ value, label: value }));
  const uavOptions = UAV_TYPES.map((value) => ({ value, label: value }));
  const rankOptions = RANKS.map((value) => ({ value, label: value }));
  const locationOptions = LOCATIONS.map((value) => ({ value, label: value }));

  function changeTableZoom(direction: -1 | 1) {
    const currentIndex = TABLE_ZOOM_STEPS.findIndex((value) => value === tableZoom);
    const fallbackIndex = TABLE_ZOOM_STEPS.findIndex((value) => value >= tableZoom);
    const baseIndex = currentIndex >= 0 ? currentIndex : Math.max(0, fallbackIndex);
    const nextIndex = Math.min(
      TABLE_ZOOM_STEPS.length - 1,
      Math.max(0, baseIndex + direction),
    );
    setTableZoom(TABLE_ZOOM_STEPS[nextIndex]);
  }

  useEffect(() => {
    if (!tauriAvailable) {
      setDraftReady(true);
      return;
    }
    let disposed = false;
    void invoke<string | null>("load_workspace_draft", { variant })
      .then((payload) => {
        if (disposed || !payload) return;
        const draft = JSON.parse(payload) as Partial<WorkspaceDraft>;
        const restoredBlocks = normalizeLoadedBlocks(draft.blocks);
        if (draft.version !== 1 || !restoredBlocks) return;
        setUnitName(typeof draft.unitName === "string" ? draft.unitName : "");
        setReportDate(typeof draft.reportDate === "string" ? draft.reportDate : tomorrow());
        const restoredStructureType = STRUCTURE_TYPES.some((item) => item.value === draft.structureType)
          ? draft.structureType as StructureType
          : "company";
        setStructureType(restoredStructureType);
        if (typeof draft.authorizedStrength === "number") setAuthorizedStrength(draft.authorizedStrength);
        setBlocks(reconcileBlocksForStructure(restoredStructureType, restoredBlocks));
        if (draft.peopleBySlot && typeof draft.peopleBySlot === "object") {
          setPeopleBySlot(Object.fromEntries(Object.entries(draft.peopleBySlot).map(([key, person]) => [
            key,
            { ...person, fullName: formatFullName(person.fullName ?? "") },
          ])));
        }
      })
      .catch(() => setDraftStatus("error"))
      .finally(() => {
        if (!disposed) setDraftReady(true);
      });
    return () => {
      disposed = true;
    };
  }, [tauriAvailable, variant]);

  useEffect(() => {
    if (!tauriAvailable || !draftReady) return;
    setDraftStatus("saving");
    const timeout = window.setTimeout(() => {
      const draft: WorkspaceDraft = {
        version: 1,
        unitName,
        reportDate,
        structureType,
        authorizedStrength,
        blocks,
        peopleBySlot,
      };
      void invoke("save_workspace_draft", {
        variant,
        payload: JSON.stringify(draft),
      })
        .then(() => setDraftStatus("saved"))
        .catch(() => setDraftStatus("error"));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [
    authorizedStrength,
    blocks,
    draftReady,
    peopleBySlot,
    reportDate,
    structureType,
    tauriAvailable,
    unitName,
    variant,
  ]);

  useEffect(() => {
    if (!donePath) return;
    const timeout = window.setTimeout(() => setDonePath(""), 10_000);
    return () => window.clearTimeout(timeout);
  }, [donePath]);

  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(""), 10_000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  useEffect(() => {
    if (draftStatus !== "error") return;
    const timeout = window.setTimeout(() => setDraftStatus("saved"), 10_000);
    return () => window.clearTimeout(timeout);
  }, [draftStatus]);

  function updateBlock<K extends keyof StructureBlock>(id: string, field: K, value: StructureBlock[K]) {
    const shouldUppercase = field === "name"
      || field === "positionName"
      || field === "bro"
      || field === "workSector";
    const nextValue = shouldUppercase && typeof value === "string" ? upper(value) : value;
    setBlocks((current) => current.map((block) =>
      block.id === id ? { ...block, [field]: nextValue } : block,
    ));
  }

  function updateOfficialSlots(id: string, value: number) {
    const slots = Number.isFinite(value) ? Math.min(2_000, Math.max(1, Math.trunc(value))) : 1;
    updateBlock(id, "slots", slots);
  }

  function blockExists(kind: BlockKind, exceptId?: string): boolean {
    return blocks.some((block) => block.kind === kind && block.id !== exceptId);
  }

  function changeStructureType(value: StructureType) {
    setStructureType(value);
    setBlocks((current) => reconcileBlocksForStructure(value, current));
  }

  function addBlock(kind: BlockKind) {
    if (isRequiredManagementBlock(structureType, kind)) return;
    if (structureType === "platoon" && kind === "companyManagement") return;
    if (isSingletonBlockKind(kind) && blockExists(kind)) return;
    setBlocks((current) => sortBlocksByBcsOrder([...current, createBlock(kind)]));
  }

  function changeBlockKind(id: string, kind: BlockKind) {
    const currentBlock = blocks.find((block) => block.id === id);
    if (currentBlock && isRequiredManagementBlock(structureType, currentBlock.kind)) return;
    if (isRequiredManagementBlock(structureType, kind)) return;
    if (structureType === "platoon" && kind === "companyManagement") return;
    if (isSingletonBlockKind(kind) && blockExists(kind, id)) {
      setError("Такий одиничний блок уже є у структурі.");
      return;
    }
    setError("");
    setBlocks((current) => sortBlocksByBcsOrder(current.map((block) => {
      if (block.id !== id) return block;
      return {
        ...block,
        kind,
        name: upper(defaultBlockName(kind)),
        status: kind === "crew" ? (block.status || CREW_STATUSES[0]) : "",
        uavType: kind === "crew" ? (block.uavType || UAV_TYPES[0]) : "",
        bro: kind === "crew" ? block.bro : "",
        workSector: kind === "crew" ? block.workSector : "",
        uavName: kind === "crew" ? block.uavName : "",
        crewActual: kind === "crew"
          ? block.kind === "crew" ? block.crewActual : normalizedSlots(block.slots)
          : 0,
      };
    })));
  }

  function removeBlock(id: string) {
    const currentBlock = blocks.find((block) => block.id === id);
    if (currentBlock && isRequiredManagementBlock(structureType, currentBlock.kind)) return;
    setBlocks((current) => current.filter((block) => block.id !== id));
  }

  function updatePerson(
    blockId: string,
    index: number,
    field: keyof Omit<PersonInput, "blockId">,
    value: string,
  ) {
    const key = personKey(blockId, index);
    const nextValue = field === "fullName" ? formatFullName(value) : value;
    setPeopleBySlot((current) => ({
      ...current,
      [key]: { ...(current[key] ?? emptyPerson(blockId)), [field]: nextValue },
    }));
  }

  async function exportWorkbook() {
    if (exportUnavailableReason) {
      setDonePath("");
      setError(exportUnavailableReason);
      return;
    }

    const outputPath = await save({
      title: isEditor ? "Зберегти заповнений БЧС" : "Зберегти шаблон БЧС",
      defaultPath: `${safeFilePart(unitName)} ${formatDateForSheet(reportDate)}.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!outputPath) return;

    setBusy(true);
    setError("");
    setDonePath("");
    const baseRequest = {
      unitName: unitName.trim(),
      reportDate: formatReportDateForExport(reportDate),
      structureType,
      authorizedStrength,
      blocks: exportBlocks,
      outputPath,
    };

    try {
      const saved = await invoke<string>(isEditor ? "export_filled_bcs" : "export_bcs_template", {
        request: isEditor ? { ...baseRequest, people } : baseRequest,
      });
      setDonePath(saved);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  if (isEditor) {
    return (
      <main className="app-shell workspace-shell editor-sheet-shell">
        {notification && (
          <div className={`message ${notification.kind}`} role={notification.kind === "error" ? "alert" : "status"}>
            {notification.text}
          </div>
        )}

        <section className="workspace-panel bcs-document-panel">
          <div className="bcs-main-fields">
            <label className="field bcs-unit-field">
              <span>Назва підрозділу</span>
              <input
                value={unitName}
                onChange={(event) => setUnitName(event.target.value)}
                placeholder="Наприклад: 1 РУБАК"
              />
            </label>
            <label className="field">
              <span>Дата БЧС</span>
              <input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
            </label>
            <label className="field">
              <span>Тип структури</span>
              <CustomSelect
                ariaLabel="Тип структури"
                value={structureType}
                options={structureOptions}
                onChange={changeStructureType}
              />
            </label>
            <label className="field">
              <span>Усього за штатом</span>
              <NumberStepper
                ariaLabel="Усього за штатом"
                value={authorizedStrength}
                min={1}
                max={20_000}
                onChange={setAuthorizedStrength}
              />
            </label>
          </div>

          <div className="bcs-toolbar">
            <strong>Додати блок</strong>
            <div className="add-block-row" aria-label="Додати блок структури">
              {quickBlockTypesForStructure(structureType).map((item) => {
                const disabled = isSingletonBlockKind(item.value) && blockExists(item.value);
                return (
                  <button
                    type="button"
                    key={item.value}
                    className="secondary-button"
                    onClick={() => addBlock(item.value)}
                    disabled={disabled}
                  >
                    <Plus size={16} /> {item.shortLabel}
                  </button>
                );
              })}
            </div>
            <div className="bcs-zoom-control" aria-label="Масштаб таблиці">
              <span>Масштаб</span>
              <button
                type="button"
                aria-label="Зменшити масштаб таблиці"
                onClick={() => changeTableZoom(-1)}
                disabled={tableZoom === TABLE_ZOOM_STEPS[0]}
              >
                <Minus size={15} aria-hidden="true" />
              </button>
              <output aria-live="polite">{tableZoom}%</output>
              <button
                type="button"
                aria-label="Збільшити масштаб таблиці"
                onClick={() => changeTableZoom(1)}
                disabled={tableZoom === TABLE_ZOOM_STEPS[TABLE_ZOOM_STEPS.length - 1]}
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="bcs-table-scroll">
            <div
              className="bcs-table-scale"
              style={{ "--bcs-table-zoom": tableZoom / 100 } as CSSProperties}
            >
            <table className="bcs-editor-table">
              <BcsColGroup />
              <thead>
                <tr className="bcs-sheet-title-row">
                  <th colSpan={10}>
                    <div className="bcs-sheet-title">
                      <strong>БЧС</strong>
                      <div className="bcs-unit-title-line">
                        <input
                          aria-label="Назва підрозділу в заголовку БЧС"
                          value={unitName}
                          onChange={(event) => setUnitName(event.target.value)}
                          placeholder="1 РУБАК"
                        />
                        <span>419 окремого батальйону безпілотних систем</span>
                      </div>
                      <span className="bcs-sheet-date">станом на 08:00 год {formatDateForSheet(reportDate)} року</span>
                    </div>
                  </th>
                  <th colSpan={6} aria-hidden="true" />
                </tr>
                <tr className="bcs-sheet-spacer-row"><th colSpan={16} aria-hidden="true" /></tr>
                <tr className="bcs-sheet-header-row">
                  {BCS_HEADERS.map((header) => <th key={header}>{header}</th>)}
                </tr>
                <tr className="bcs-sheet-unit-row">
                  <th colSpan={16}>{unitName.trim() || "1 РУБАК"}</th>
                </tr>
              </thead>
              {blocks.map((block) => {
                const rowCount = normalizedSlots(block.slots);
                const requiredManagement = isRequiredManagementBlock(structureType, block.kind);
                const blockOptions = BLOCK_TYPES.filter((item) => {
                  if (structureType === "company" && item.value === "companyManagement") {
                    return item.value === block.kind;
                  }
                  if (structureType === "platoon"
                    && (item.value === "companyManagement" || item.value === "platoonManagement")) {
                    return item.value === block.kind;
                  }
                  return true;
                }).map((item) => ({
                  value: item.value,
                  label: item.label,
                  disabled: isSingletonBlockKind(item.value) && blockExists(item.value, block.id),
                }));
                const blockClass = block.kind === "crew" ? statusClass(block.status) : blockTableClass(block.kind);

                return (
                  <tbody key={block.id} className={`bcs-block ${blockClass}`}>
                    {Array.from({ length: rowCount }, (_, personIndex) => {
                      const key = personKey(block.id, personIndex);
                      const person = peopleBySlot[key] ?? emptyPerson(block.id);
                      const startedPerson = personHasAnyData(person);
                      return (
                        <tr key={key}>
                          {personIndex === 0 && (
                            <>
                              <td rowSpan={rowCount} className="bcs-block-cell bcs-section-cell">
                                <div className={`bcs-cell-stack${blockNameIsSection(block.kind) ? " bcs-cell-stack-named" : ""}`}>
                                  <CustomSelect
                                    ariaLabel="Підрозділи по типу"
                                    value={block.kind}
                                    options={blockOptions}
                                    onChange={(value) => changeBlockKind(block.id, value)}
                                    disabled={requiredManagement}
                                  />
                                  {blockNameIsSection(block.kind) && (
                                    <input
                                      aria-label={blockNameLabel(block.kind)}
                                      value={block.name}
                                      onChange={(event) => updateBlock(block.id, "name", event.target.value)}
                                      placeholder={blockNamePlaceholder(block.kind)}
                                    />
                                  )}
                                  {!requiredManagement && (
                                    <button
                                      type="button"
                                      className="bcs-remove-block"
                                      aria-label={`Видалити ${block.name || blockTypeLabel(block.kind)}`}
                                      title="Видалити блок"
                                      onClick={() => removeBlock(block.id)}
                                    >
                                      <Trash2 size={15} /> Видалити
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell">
                                <input
                                  aria-label="Назва позиції"
                                  value={block.positionName}
                                  onChange={(event) => updateBlock(block.id, "positionName", event.target.value)}
                                  placeholder="Назва позиції"
                                />
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell">
                                {block.kind === "crew" ? (
                                  <input
                                    aria-label="БРО"
                                    value={block.bro}
                                    onChange={(event) => updateBlock(block.id, "bro", event.target.value)}
                                  />
                                ) : <span className="bcs-empty-value">—</span>}
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell">
                                {block.kind === "crew" ? (
                                  <input
                                    aria-label="Сектор роботи"
                                    value={block.workSector}
                                    onChange={(event) => updateBlock(block.id, "workSector", event.target.value)}
                                  />
                                ) : <span className="bcs-empty-value">—</span>}
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell">
                                {block.kind === "crew" ? (
                                  <input
                                    aria-label="Назва екіпажу"
                                    value={block.name}
                                    onChange={(event) => updateBlock(block.id, "name", event.target.value)}
                                    placeholder="Назва екіпажу"
                                  />
                                ) : <span className="bcs-empty-value">—</span>}
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell bcs-number-cell">
                                {block.kind === "crew" ? (
                                  <NumberStepper
                                    ariaLabel="Фактично осіб в екіпажі"
                                    value={block.crewActual}
                                    min={0}
                                    max={2_000}
                                    onChange={(value) => updateBlock(block.id, "crewActual", value)}
                                  />
                                ) : <span className="bcs-empty-value">—</span>}
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell bcs-number-cell bcs-official-cell">
                                <NumberStepper
                                  ariaLabel="Кількість в/с"
                                  value={block.slots}
                                  min={1}
                                  max={2_000}
                                  onChange={(value) => updateOfficialSlots(block.id, value)}
                                />
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell bcs-status-cell">
                                {block.kind === "crew" ? (
                                  <CustomSelect
                                    ariaLabel="Статус екіпажу"
                                    value={block.status}
                                    options={statusOptions}
                                    onChange={(value) => updateBlock(block.id, "status", value)}
                                  />
                                ) : <span className="bcs-empty-value">—</span>}
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell">
                                {block.kind === "crew" ? (
                                  <input
                                    aria-label="Назва БпАК"
                                    value={block.uavName}
                                    onChange={(event) => updateBlock(block.id, "uavName", event.target.value)}
                                  />
                                ) : <span className="bcs-empty-value">—</span>}
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell">
                                {block.kind === "crew" ? (
                                  <CustomSelect
                                    ariaLabel="Тип БпАК"
                                    value={block.uavType}
                                    options={uavOptions}
                                    onChange={(value) => updateBlock(block.id, "uavType", value)}
                                  />
                                ) : <span className="bcs-empty-value">—</span>}
                              </td>
                            </>
                          )}
                          <td><input aria-label={`Посада по штату, рядок ${personIndex + 1}`} value={person.position} onChange={(event) => updatePerson(block.id, personIndex, "position", event.target.value)} /></td>
                          <td className={startedPerson && !person.rank.trim() ? "bcs-warning-cell" : ""}>
                            <CustomSelect
                              ariaLabel={`Військове звання, рядок ${personIndex + 1}`}
                              value={person.rank}
                              options={rankOptions}
                              placeholder="Не вказано"
                              onChange={(value) => updatePerson(block.id, personIndex, "rank", value)}
                            />
                          </td>
                          <td className={startedPerson && !person.fullName.trim() ? "bcs-warning-cell" : ""}><input aria-label={`П.І.Б., рядок ${personIndex + 1}`} value={person.fullName} onChange={(event) => updatePerson(block.id, personIndex, "fullName", event.target.value)} /></td>
                          <td><input aria-label={`Функціональні обов'язки, рядок ${personIndex + 1}`} value={person.duties} onChange={(event) => updatePerson(block.id, personIndex, "duties", event.target.value)} /></td>
                          <td className={startedPerson && !person.location.trim() ? "bcs-warning-cell" : ""}>
                            <CustomSelect
                              ariaLabel={`Де знаходиться, рядок ${personIndex + 1}`}
                              value={person.location}
                              options={locationOptions}
                              onChange={(value) => updatePerson(block.id, personIndex, "location", value)}
                            />
                          </td>
                          <td><input aria-label={`Примітка, рядок ${personIndex + 1}`} value={person.note} onChange={(event) => updatePerson(block.id, personIndex, "note", event.target.value)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
            <table className="bcs-editor-table bcs-summary-table" aria-label="Підсумки БЧС">
              <BcsColGroup />
              <tbody>
                <tr className="bcs-summary-gap"><td colSpan={16} /></tr>
                <tr className="bcs-summary-title-row">
                  <td colSpan={4} />
                  <td className="bcs-summary-title">БЧС {unitName.trim() || "1 РУБАК"}:</td>
                  <td />
                  <td colSpan={2} />
                  <td className="bcs-summary-title">БЧС по функціоналу:</td>
                  <td />
                  <td />
                  <td className="bcs-summary-title">Де знаходиться</td>
                  <td />
                  <td colSpan={3} />
                </tr>
                {Array.from({ length: sheetSummary.rowCount }, (_, index) => (
                  <tr className="bcs-summary-data-row" key={`summary-${index}`}>
                    <td colSpan={4} />
                    {sheetSummary.main[index] ? (
                      <>
                        <td className="bcs-summary-cell">{sheetSummary.main[index][0]}</td>
                        <td className="bcs-summary-cell">{sheetSummary.main[index][1]}</td>
                      </>
                    ) : <td colSpan={2} />}
                    <td colSpan={2} />
                    {sheetSummary.functional[index] ? (
                      <>
                        <td className="bcs-summary-cell">{sheetSummary.functional[index][0]}</td>
                        <td className="bcs-summary-cell">{sheetSummary.functional[index][1]}</td>
                      </>
                    ) : <td colSpan={2} />}
                    <td />
                    {sheetSummary.locations[index] ? (
                      <>
                        <td className="bcs-summary-cell">{sheetSummary.locations[index][0]}</td>
                        <td className="bcs-summary-cell">{sheetSummary.locations[index][1]}</td>
                      </>
                    ) : <td colSpan={2} />}
                    <td colSpan={3} />
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </section>

        <footer className="export-bar">
          <div>
            <b>{exportUnavailableReason ? "Експорт недоступний" : "Готово до експорту"}</b>
            <span>{places} рядків у структурі · {authorizedStrength} за штатом (довідково)</span>
            {exportUnavailableReason && <span className="count-warning">{exportUnavailableReason}</span>}
            {tauriAvailable && (
              <span className={draftStatus === "error" ? "autosave-error" : "autosave-status"}>
                {draftStatus === "saving" && "Зберігаю зміни…"}
                {draftStatus === "saved" && "Зміни збережено"}
                {draftStatus === "error" && "Не вдалося зберегти чернетку"}
              </span>
            )}
          </div>
          <button
            className="primary-button"
            onClick={exportWorkbook}
            disabled={busy || Boolean(exportUnavailableReason)}
            title={exportUnavailableReason || undefined}
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
            Зберегти БЧС у XLSX
          </button>
        </footer>
      </main>
    );
  }

  return (
    <main className="app-shell workspace-shell">
      <header className="app-header workspace-header">
        <div>
          <h1>{isEditor ? "Редактор БЧС" : "Шаблон БЧС"}</h1>
          <p>{isEditor ? "Створіть структуру, заповніть людей і збережіть XLSX" : "Створіть чистий XLSX під потрібну структуру"}</p>
        </div>
      </header>

      {notification && (
        <div className={`message ${notification.kind}`} role={notification.kind === "error" ? "alert" : "status"}>
          {notification.text}
        </div>
      )}

      <section className="workspace-panel setup-panel">
        <div className="section-heading">
          <span className="step-number">1</span>
          <h2>Основне</h2>
        </div>
        <div className="form-grid basic-grid">
          <label className="field field-wide">
            <span>Назва підрозділу</span>
            <input
              value={unitName}
              onChange={(event) => setUnitName(event.target.value)}
              placeholder="Наприклад: 1 РУБАК"
            />
          </label>
          <label className="field">
            <span>Дата БЧС</span>
            <input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
          </label>
          <label className="field">
            <span>Тип структури</span>
            <CustomSelect
              ariaLabel="Тип структури"
              value={structureType}
              options={structureOptions}
              onChange={changeStructureType}
            />
          </label>
          <label className="field">
            <span>Усього за штатом</span>
            <NumberStepper
              ariaLabel="Усього за штатом"
              value={authorizedStrength}
              min={1}
              max={20_000}
              onChange={setAuthorizedStrength}
            />
          </label>
        </div>
      </section>

      <section className="workspace-panel structure-panel">
        <div className="section-heading section-heading-row">
          <div className="heading-group">
            <span className="step-number">2</span>
            <div>
              <h2>Структура</h2>
              <p>Додайте або видаліть потрібні блоки.</p>
            </div>
          </div>
          <div className="metric"><b>{places}</b><span>місць створено</span></div>
        </div>

        <div className="add-block-row" aria-label="Додати блок структури">
          {quickBlockTypesForStructure(structureType).map((item) => {
            const disabled = isSingletonBlockKind(item.value) && blockExists(item.value);
            return (
              <button
                type="button"
                key={item.value}
                className="secondary-button"
                onClick={() => addBlock(item.value)}
                disabled={disabled}
              >
                <Plus size={16} /> {item.shortLabel}
              </button>
            );
          })}
        </div>

        <div className="block-list">
          {blocks.map((block, index) => {
            const requiredManagement = isRequiredManagementBlock(structureType, block.kind);
            const blockOptions = BLOCK_TYPES.filter((item) => {
              if (structureType === "company" && item.value === "companyManagement") {
                return item.value === block.kind;
              }
              if (structureType === "platoon"
                && (item.value === "companyManagement" || item.value === "platoonManagement")) {
                return item.value === block.kind;
              }
              return true;
            }).map((item) => ({
              value: item.value,
              label: item.label,
              disabled: isSingletonBlockKind(item.value) && blockExists(item.value, block.id),
            }));
            const displayName = block.name.trim() || blockNameLabel(block.kind);
            return (
              <article key={block.id} className={`structure-card ${statusClass(block.status)}`}>
                <div className="structure-card-header">
                  <div>
                    <span className="block-number">{index + 1}</span>
                    <strong>{displayName}</strong>
                  </div>
                  {!requiredManagement && (
                    <button
                      type="button"
                      className="icon-button danger-button"
                      aria-label={`Видалити ${displayName}`}
                      title="Видалити блок"
                      onClick={() => removeBlock(block.id)}
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </div>

                <div className="block-fields">
                  <label className="field">
                    <span>Тип блоку</span>
                    <CustomSelect
                      ariaLabel="Тип блоку"
                      value={block.kind}
                      options={blockOptions}
                      onChange={(value) => changeBlockKind(block.id, value)}
                      disabled={requiredManagement}
                    />
                  </label>
                  <label className="field">
                    <span>{blockNameLabel(block.kind)}</span>
                    <input
                      value={block.name}
                      onChange={(event) => updateBlock(block.id, "name", event.target.value)}
                      placeholder={blockNamePlaceholder(block.kind)}
                    />
                  </label>
                  <label className="field">
                    <span>Назва позиції</span>
                    <input
                      value={block.positionName}
                      onChange={(event) => updateBlock(block.id, "positionName", event.target.value)}
                      placeholder="Введіть назву позиції"
                    />
                  </label>
                  <label className="field">
                    <span>{block.kind === "crew" ? "Кількість в/с" : "Кількість людей"}</span>
                    <NumberStepper
                      ariaLabel={block.kind === "crew" ? "Кількість в/с" : "Кількість людей"}
                      value={block.slots}
                      min={1}
                      max={2_000}
                      onChange={(value) => updateOfficialSlots(block.id, value)}
                    />
                  </label>

                  {block.kind === "crew" && (
                    <>
                      <label className="field">
                        <span>Фактично осіб в екіпажі</span>
                        <NumberStepper
                          ariaLabel="Фактично осіб в екіпажі"
                          value={block.crewActual}
                          min={0}
                          max={2_000}
                          onChange={(value) => updateBlock(block.id, "crewActual", value)}
                        />
                      </label>
                      <label className="field">
                        <span>БРО</span>
                        <input
                          value={block.bro}
                          onChange={(event) => updateBlock(block.id, "bro", event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>Сектор роботи</span>
                        <input
                          value={block.workSector}
                          onChange={(event) => updateBlock(block.id, "workSector", event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>Статус екіпажу</span>
                        <CustomSelect
                          ariaLabel="Статус екіпажу"
                          value={block.status}
                          options={statusOptions}
                          onChange={(value) => updateBlock(block.id, "status", value)}
                        />
                      </label>
                      <label className="field">
                        <span>Назва БпАК</span>
                        <input
                          value={block.uavName}
                          onChange={(event) => updateBlock(block.id, "uavName", event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>Тип БпАК</span>
                        <CustomSelect
                          ariaLabel="Тип БпАК"
                          value={block.uavType}
                          options={uavOptions}
                          onChange={(value) => updateBlock(block.id, "uavType", value)}
                        />
                      </label>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {isEditor && (
        <section className="workspace-panel people-panel">
          <div className="section-heading">
            <span className="step-number">3</span>
            <h2>Особовий склад</h2>
          </div>

          <div className="people-groups">
            {blocks.map((block) => {
              const displayName = block.name.trim() || blockNameLabel(block.kind);
              return (
                <details
                  key={block.id}
                  className="people-group"
                  open={openBlocks.has(block.id)}
                  onToggle={(event) => {
                    const isOpen = event.currentTarget.open;
                    setOpenBlocks((current) => {
                      const next = new Set(current);
                      if (isOpen) next.add(block.id);
                      else next.delete(block.id);
                      return next;
                    });
                  }}
                >
                  <summary>
                    <Users size={17} />
                    {displayName}
                    <span>{block.slots} ос.</span>
                  </summary>
                  {openBlocks.has(block.id) && (
                    <div className="person-list">
                      {Array.from({ length: normalizedSlots(block.slots) }, (_, personIndex) => {
                        const key = personKey(block.id, personIndex);
                        const person = peopleBySlot[key] ?? emptyPerson(block.id);
                        return (
                          <section className="person-card" key={key}>
                            <div className="person-card-header">
                              <strong>Людина {personIndex + 1}</strong>
                            </div>
                            <div className="person-fields">
                              <label className="field person-name-field">
                                <span>П.І.Б.</span>
                                <input
                                  value={person.fullName}
                                  onChange={(event) => updatePerson(block.id, personIndex, "fullName", event.target.value)}
                                />
                              </label>
                              <label className="field">
                                <span>Посада</span>
                                <input
                                  value={person.position}
                                  onChange={(event) => updatePerson(block.id, personIndex, "position", event.target.value)}
                                />
                              </label>
                              <label className="field">
                                <span>Звання</span>
                                <CustomSelect
                                  ariaLabel="Звання"
                                  value={person.rank}
                                  options={rankOptions}
                                  placeholder="Не вказано"
                                  onChange={(value) => updatePerson(block.id, personIndex, "rank", value)}
                                />
                              </label>
                              <label className="field">
                                <span>Обов'язки</span>
                                <input
                                  value={person.duties}
                                  onChange={(event) => updatePerson(block.id, personIndex, "duties", event.target.value)}
                                />
                              </label>
                              <label className={`field ${person.fullName && !person.location ? "field-warning" : ""}`}>
                                <span>Де знаходиться</span>
                                <CustomSelect
                                  ariaLabel="Де знаходиться"
                                  value={person.location}
                                  options={locationOptions}
                                  onChange={(value) => updatePerson(block.id, personIndex, "location", value)}
                                />
                              </label>
                              <label className="field">
                                <span>Примітка</span>
                                <input
                                  value={person.note}
                                  onChange={(event) => updatePerson(block.id, personIndex, "note", event.target.value)}
                                />
                              </label>
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  )}
                </details>
              );
            })}
          </div>
        </section>
      )}

      <footer className="export-bar">
        <div>
          <b>{exportUnavailableReason ? "Експорт недоступний" : isEditor ? "Готово до експорту" : "Шаблон буде з формулами та списками"}</b>
          <span>{places} місць у структурі · {authorizedStrength} за штатом (довідково)</span>
          {exportUnavailableReason && <span className="count-warning">{exportUnavailableReason}</span>}
          {tauriAvailable && (
            <span className={draftStatus === "error" ? "autosave-error" : "autosave-status"}>
              {draftStatus === "saving" && "Зберігаю зміни…"}
              {draftStatus === "saved" && "Зміни збережено"}
              {draftStatus === "error" && "Не вдалося зберегти чернетку"}
            </span>
          )}
        </div>
        <button
          className="primary-button"
          onClick={exportWorkbook}
          disabled={busy || Boolean(exportUnavailableReason)}
          title={exportUnavailableReason || undefined}
        >
          {busy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
          {isEditor ? "Зберегти БЧС у XLSX" : "Створити шаблон XLSX"}
        </button>
      </footer>
    </main>
  );
}
