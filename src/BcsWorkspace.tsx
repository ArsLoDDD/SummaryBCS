import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, ChevronUp, Download, LoaderCircle, Minus, Plus, Trash2, Upload, Users } from "lucide-react";
import CustomSelect, { type CustomSelectOption } from "./CustomSelect";
import BcsDataPanel from "./BcsDataPanel";
import {
  normalizeEditorData,
  removeEditorBlock,
  updateEditorBlock,
  type BcsEditorData,
} from "./bcsEditorData";
import { restoreWorkspaceDraft, type RestoredWorkspace, type WorkspaceDraft } from "./bcsWorkspaceDraft";
import { WorkspaceSaveQueue } from "./workspaceSaveQueue";
import { buildBcsSheetSummary } from "./bcsSummary";
import { clampNumberStepperValue, parseNumberStepperInput } from "./numberStepper";
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
  defaultBlockName,
  emptyPerson,
  formatBlockName,
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
  const [isEmpty, setIsEmpty] = useState(false);
  const apply = (next: number) => {
    setIsEmpty(false);
    onChange(clampNumberStepperValue(next, min, max));
  };

  return (
    <div className="number-stepper">
      <input
        aria-label={ariaLabel}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={isEmpty ? "" : value}
        onChange={(event) => {
          const next = parseNumberStepperInput(event.target.value, min, max);
          if (next === null) setIsEmpty(true);
          else apply(next);
        }}
        onBlur={(event) => apply(parseNumberStepperInput(event.target.value, min, max) ?? min)}
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

const TABLE_ZOOM_STEPS = [50, 60, 70, 80, 90, 100, 110, 125] as const;

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
  if (kind === "temporary" || kind === "temporaryActing") return "block-temporary";
  if (kind === "custom") return "block-other";
  if (kind === "unassigned") return "block-unassigned";
  return "block-section";
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

export default function BcsWorkspace({ variant }: Props) {
  const isEditor = variant === "editor";
  const [unitName, setUnitName] = useState("");
  const [reportDate, setReportDate] = useState(tomorrow);
  const [structureType, setStructureType] = useState<StructureType>("company");
  const [authorizedStrength, setAuthorizedStrength] = useState(10);
  const [editorData, setEditorData] = useState<BcsEditorData>(() => normalizeEditorData(createDefaultCompanyBlocks(), {}));
  const { blocks, peopleBySlot, positions, positionByBlock } = editorData;
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(() => new Set());
  const [editorTab, setEditorTab] = useState<"bcs" | "data">("bcs");
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [donePath, setDonePath] = useState("");
  const [notice, setNotice] = useState("");
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [pendingImport, setPendingImport] = useState<RestoredWorkspace | null>(null);
  const [draftLoadBlocked, setDraftLoadBlocked] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saved" | "saving" | "error">("saved");
  const [tableZoom, setTableZoom] = useState(80);
  const saveQueue = useMemo(() => new WorkspaceSaveQueue((payload) =>
    invoke<void>("save_workspace_draft", { variant, payload }),
  ), [variant]);
  const latestDraftPayload = useRef("");
  const saveGeneration = useRef(0);
  const closeInProgress = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

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
  const personValidation = useMemo(() => {
    const missing = new Set<string>();
    let incompleteCount = 0;
    if (isEditor) {
      people.forEach((person) => {
        const missingForPerson = missingRequiredPersonFields(person);
        if (missingForPerson.length > 0) incompleteCount += 1;
        missingForPerson.forEach((field) => missing.add(field));
      });
    }
    return { incompleteCount, missingFields: [...missing] };
  }, [isEditor, people]);
  const personValidationError = personValidation.incompleteCount > 0
    ? `Не заповнено місць: ${personValidation.incompleteCount}. Для кожного вкажіть: ${personValidation.missingFields.join(", ")}.`
    : "";
  const exportUnavailableReason = workspaceValidationError || personValidationError;
  const sheetSummary = useMemo(() => buildBcsSheetSummary(authorizedStrength, blocks, peopleBySlot),
    [authorizedStrength, blocks, peopleBySlot]);
  const tauriAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const draftPayload = useMemo(() => JSON.stringify({
    version: 1, unitName, reportDate, structureType, authorizedStrength,
    blocks, peopleBySlot, positions, positionByBlock, importWarnings,
  } satisfies WorkspaceDraft), [unitName, reportDate, structureType, authorizedStrength, blocks, peopleBySlot, positions, positionByBlock, importWarnings]);
  latestDraftPayload.current = draftPayload;
  const notification = error
    ? { kind: "error", text: error }
    : donePath
      ? { kind: "success", text: `Файл збережено: ${donePath}` }
      : notice
        ? { kind: "success", text: notice }
        : draftStatus === "error"
          ? { kind: "error", text: "Не вдалося зберегти чернетку." }
          : null;

  const structureOptions = STRUCTURE_TYPES as ReadonlyArray<CustomSelectOption<StructureType>>;
  const statusOptions = [
    ...CREW_STATUSES.map((value) => ({ value, label: value })),
    ...[...new Set(blocks.map((block) => block.status).filter((value) => value && !CREW_STATUSES.some((status) => status === value)))].map((value) => ({ value, label: `${value} (невідоме значення)`, disabled: true })),
  ];
  const uavOptions = [
    ...UAV_TYPES.map((value) => ({ value, label: value })),
    ...[...new Set(blocks.map((block) => block.uavType).filter((value) => value && !UAV_TYPES.some((type) => type === value)))].map((value) => ({ value, label: `${value} (невідоме значення)`, disabled: true })),
  ];
  const rankOptions = [
    ...RANKS.map((value) => ({ value, label: value })),
    ...[...new Set(people.map((person) => person.rank).filter((value) => value && !RANKS.some((rank) => rank === value)))].map((value) => ({ value, label: value, disabled: true })),
  ];
  const locationOptions = [
    ...LOCATIONS.map((value) => ({ value, label: value })),
    ...[...new Set(people.map((person) => person.location).filter((value) => value && !LOCATIONS.includes(value)))].map((value) => ({ value, label: `${value} (невідоме значення)`, disabled: true })),
  ];
  const applyRestoredWorkspace = useCallback(({ draft, data }: RestoredWorkspace) => {
    setUnitName(draft.unitName);
    setReportDate(draft.reportDate);
    setStructureType(draft.structureType);
    setAuthorizedStrength(draft.authorizedStrength);
    setEditorData(data);
    setImportWarnings(draft.importWarnings ?? []);
  }, []);

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
        const restored = restoreWorkspaceDraft(JSON.parse(payload));
        if (!restored) throw new Error("Збережені дані мають невідомий або пошкоджений формат.");
        applyRestoredWorkspace(restored);
      })
      .catch((cause) => {
        if (disposed) return;
        setDraftLoadBlocked(true);
        setDraftStatus("error");
        setError(`${messageFrom(cause)} Початкову чернетку збережено без змін.`);
      })
      .finally(() => {
        if (!disposed) setDraftReady(true);
      });
    return () => {
      disposed = true;
    };
  }, [tauriAvailable, variant, applyRestoredWorkspace]);

  useEffect(() => {
    if (!tauriAvailable || !draftReady || draftLoadBlocked) return;
    const generation = ++saveGeneration.current;
    setDraftStatus("saving");
    void saveQueue.enqueue(draftPayload)
      .then(() => { if (generation === saveGeneration.current) setDraftStatus("saved"); })
      .catch(() => { if (generation === saveGeneration.current) setDraftStatus("error"); });
  }, [tauriAvailable, draftReady, draftLoadBlocked, draftPayload, saveQueue]);

  useEffect(() => {
    if (!tauriAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow.onCloseRequested((event) => {
      if (!draftReady || draftLoadBlocked) return;
      event.preventDefault();
      if (busyRef.current) return;
      if (closeInProgress.current) return;
      closeInProgress.current = true;
      setBusy(true);
      void saveQueue.enqueue(latestDraftPayload.current)
        .then(() => saveQueue.flush())
        .then(() => appWindow.destroy())
        .catch((cause) => {
          closeInProgress.current = false;
          setBusy(false);
          setDraftStatus("error");
          setError(`Зміни ще не збережено. Вікно залишено відкритим: ${messageFrom(cause)}`);
        });
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch((cause) => setError(`Не вдалося ввімкнути збереження перед закриттям: ${messageFrom(cause)}`));
    return () => { disposed = true; unlisten?.(); };
  }, [tauriAvailable, draftReady, draftLoadBlocked, saveQueue]);

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
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 10_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function updateBlock<K extends keyof StructureBlock>(id: string, field: K, value: StructureBlock[K]) {
    try {
      setEditorData(updateEditorBlock(editorData, id, { [field]: value }));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  function updateOfficialSlots(id: string, value: number) {
    const slots = Number.isFinite(value) ? Math.min(2_000, Math.max(1, Math.trunc(value))) : 1;
    updateBlock(id, "slots", slots);
  }

  function blockExists(kind: BlockKind, exceptId?: string): boolean {
    return blocks.some((block) => block.kind === kind && block.id !== exceptId);
  }

  function changeStructureType(value: StructureType) {
    if (value === "platoon" && blocks.some((block) => block.kind === "companyManagement"
      && Array.from({ length: normalizedSlots(block.slots) }, (_, index) =>
        peopleBySlot[personKey(block.id, index)],
      ).some((person) => person && personHasAnyData(person)))) {
      setError("Спочатку перенесіть людей з управління роти в інші підрозділи у вкладці «Дані».");
      return;
    }
    setStructureType(value);
    setEditorData(normalizeEditorData(
      reconcileBlocksForStructure(value, blocks), peopleBySlot, positions, positionByBlock,
    ));
  }

  function addBlock(kind: BlockKind) {
    if (isRequiredManagementBlock(structureType, kind)) return;
    if (structureType === "platoon" && kind === "companyManagement") return;
    if (isSingletonBlockKind(kind) && blockExists(kind)) return;
    setEditorData(normalizeEditorData(
      sortBlocksByBcsOrder([...blocks, createBlock(kind)]), peopleBySlot, positions, positionByBlock,
    ));
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
    try {
      setEditorData(updateEditorBlock(editorData, id, {
        kind,
        name: formatBlockName(kind, defaultBlockName(kind)),
      }));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  function removeBlock(id: string) {
    const currentBlock = blocks.find((block) => block.id === id);
    if (currentBlock && isRequiredManagementBlock(structureType, currentBlock.kind)) return;
    const hasPeople = currentBlock && Array.from({ length: normalizedSlots(currentBlock.slots) }, (_, index) =>
      peopleBySlot[personKey(id, index)],
    ).some((person) => person && personHasAnyData(person));
    if (hasPeople) {
      setBlockToDelete(id);
      return;
    }
    setEditorData(removeEditorBlock(editorData, id));
  }

  function updatePerson(
    blockId: string,
    index: number,
    field: keyof Omit<PersonInput, "blockId">,
    value: string,
  ) {
    const key = personKey(blockId, index);
    const nextValue = field === "fullName" ? formatFullName(value) : value;
    setEditorData((current) => ({
      ...current,
      peopleBySlot: {
        ...current.peopleBySlot,
        [key]: { ...(current.peopleBySlot[key] ?? emptyPerson(blockId)), [field]: nextValue },
      },
    }));
  }

  async function applyWorkbookImport(restored: RestoredWorkspace) {
    setPendingImport(null);
    setBusy(true);
    setError("");
    setDonePath("");
    try {
      if (!draftLoadBlocked) {
        await saveQueue.enqueue(latestDraftPayload.current);
        await saveQueue.flush();
      }
      const backupPath = await invoke<string | null>("backup_workspace_draft", { variant });
      await saveQueue.enqueue(JSON.stringify(restored.draft));
      await saveQueue.flush();
      applyRestoredWorkspace(restored);
      setDraftLoadBlocked(false);
      setDraftReady(true);
      setDraftStatus("saved");
      setEditorTab("data");
      setNotice(`Імпортовано: ${totalSlots(restored.data.blocks)} місць, ${restored.data.blocks.length} підрозділів, ${restored.data.positions.length} позицій.${backupPath ? " Попередню чернетку збережено в резервній копії." : ""}`);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importWorkbook() {
    if (!tauriAvailable || busy) return;
    try {
      const selected = await open({ title: "Імпортувати БЧС підрозділу", multiple: false,
        filters: [{ name: "БЧС Excel", extensions: ["xlsx"] }],
      });
      if (typeof selected !== "string") return;
      setBusy(true);
      setError("");
      const imported = await invoke<Record<string, unknown>>("import_bcs_editor", { path: selected });
      const restored = restoreWorkspaceDraft({ ...imported, importWarnings: imported.warnings });
      if (!restored) throw new Error("Не вдалося відновити структуру імпортованого БЧС.");
      setBusy(false);
      const hasCurrentData = unitName.trim() || people.some(personHasAnyData) || positions.length > 0 || draftLoadBlocked;
      if (hasCurrentData) setPendingImport(restored);
      else await applyWorkbookImport(restored);
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
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
        {(busy || !draftReady) && <div className="bcs-working-overlay" role="status"><LoaderCircle className="spin" size={24} /><span>{!draftReady ? "Відкриваю збережені дані…" : "Зберігаю та перевіряю дані…"}</span></div>}
        {pendingImport && <div className="reason-modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") setPendingImport(null); }}>
          <form className="reason-modal" role="dialog" aria-modal="true" aria-labelledby="bcs-import-title" onSubmit={(event) => { event.preventDefault(); void applyWorkbookImport(pendingImport); }}>
            <h2 id="bcs-import-title">Імпортувати БЧС?</h2>
            <p>Файл містить {pendingImport.data.blocks.length} підрозділів і {totalSlots(pendingImport.data.blocks)} місць для людей. Поточні дані будуть замінені. Перед заміною програма збереже їхню зашифровану резервну копію.</p>
            <div className="reason-modal-actions"><button type="button" className="secondary-button" onClick={() => setPendingImport(null)}>Скасувати</button><button autoFocus type="submit" className="primary-button">Імпортувати</button></div>
          </form>
        </div>}
        {blockToDelete && (
          <div className="reason-modal-backdrop" onKeyDown={(event) => {
            if (event.key === "Escape") setBlockToDelete(null);
          }}>
            <form className="reason-modal" role="dialog" aria-modal="true" aria-labelledby="bcs-delete-title" onSubmit={(event) => {
              event.preventDefault();
              setEditorData(removeEditorBlock(editorData, blockToDelete));
              setBlockToDelete(null);
            }}>
              <h2 id="bcs-delete-title">Видалити підрозділ?</h2>
              <p>Блок «{blocks.find((block) => block.id === blockToDelete)?.name}» і всі заповнені в ньому люди будуть видалені. Щоб зберегти людей, спочатку перенесіть їх у вкладці «Дані».</p>
              <div className="reason-modal-actions">
                <button type="button" className="secondary-button" onClick={() => setBlockToDelete(null)}>Скасувати</button>
                <button autoFocus type="submit" className="primary-button">Видалити</button>
              </div>
            </form>
          </div>
        )}
        {notification && (
          <div className={`message ${notification.kind}`} role={notification.kind === "error" ? "alert" : "status"}>
            {notification.text}
          </div>
        )}

        <section className="workspace-panel bcs-document-panel">
          <nav className="bcs-editor-tabs" aria-label="Розділи редактора">
            <button type="button" className={editorTab === "bcs" ? "active" : ""} aria-pressed={editorTab === "bcs"} onClick={() => setEditorTab("bcs")}>БЧС</button>
            <button type="button" className={editorTab === "data" ? "active" : ""} aria-pressed={editorTab === "data"} onClick={() => setEditorTab("data")}>Дані</button>
            <button type="button" className="bcs-import-button" disabled={busy || !draftReady || !tauriAvailable} title={!tauriAvailable ? "Для імпорту запустіть програму командою npm run app:editor" : "Заповнити редактор із готового Excel-файла БЧС"} onClick={() => void importWorkbook()}><Upload size={16} /> Імпортувати БЧС</button>
          </nav>
          {draftLoadBlocked && <div className="bcs-storage-warning" role="alert">Не вдалося відкрити чернетку. Автозбереження зупинено, щоб зберегти початковий файл. Імпорт іншого БЧС створить його резервну копію.</div>}
          {importWarnings.length > 0 && <details className="bcs-import-warnings"><summary>Зауваження до імпортованого файла: {importWarnings.length}</summary><ul>{importWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
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

          {editorTab === "data" ? (
            <BcsDataPanel
              data={editorData}
              structureType={structureType}
              summary={sheetSummary}
              onChange={setEditorData}
              onError={setError}
              onAddBlock={addBlock}
            />
          ) : <>
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
                                  <input
                                    aria-label="БРО"
                                    value={block.bro}
                                    onChange={(event) => updateBlock(block.id, "bro", event.target.value)}
                                  />
                              </td>
                              <td rowSpan={rowCount} className="bcs-block-cell">
                                  <input
                                    aria-label="Сектор роботи"
                                    value={block.workSector}
                                    onChange={(event) => updateBlock(block.id, "workSector", event.target.value)}
                                  />
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
                          <td className={!person.rank.trim() ? "bcs-warning-cell" : ""}>
                            <CustomSelect
                              ariaLabel={`Військове звання, рядок ${personIndex + 1}`}
                              value={person.rank}
                              options={rankOptions}
                              placeholder="Не вказано"
                              onChange={(value) => updatePerson(block.id, personIndex, "rank", value)}
                            />
                          </td>
                          <td className={!person.fullName.trim() ? "bcs-warning-cell" : ""}><input aria-label={`П.І.Б., рядок ${personIndex + 1}`} value={person.fullName} onChange={(event) => updatePerson(block.id, personIndex, "fullName", event.target.value)} /></td>
                          <td><input aria-label={`Функціональні обов'язки, рядок ${personIndex + 1}`} value={person.duties} onChange={(event) => updatePerson(block.id, personIndex, "duties", event.target.value)} /></td>
                          <td className={!LOCATIONS.includes(person.location) ? "bcs-warning-cell" : ""}>
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
          </>}
        </section>

        <footer className="export-bar">
          <div>
            <b>{exportUnavailableReason ? "Експорт недоступний" : "Готово до експорту"}</b>
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
