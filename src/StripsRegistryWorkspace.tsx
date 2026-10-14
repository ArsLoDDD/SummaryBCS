import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FileUp,
  Link2,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import CustomSelect, { type CustomSelectOption } from "./CustomSelect";
import RegistryHistoryInput from "./RegistryHistoryInput";
import StripsReportView from "./StripsReportView";
import { collectRegistryHistory } from "./registryHistory";
import { UAV_TYPES } from "./structure";
import {
  CREW_DUTIES,
  CREW_READINESS,
  POSITION_READINESS,
  readinessDisplay,
  upperUk,
  validateStripsReportErrors,
  type CrewDuty,
  type CrewReadiness,
  type PositionReadiness,
  type UavType,
} from "./strips";
import {
  createDemoStripsRegistry,
  createEmptyStripsRegistry,
  createRegistryAssignment,
  createRegistryCrew,
  createRegistryPosition,
  isEffectivelyEmptyStripsRegistry,
  normalizeStripsRegistry,
  positionForCrew,
  registryToStripsReport,
  validateStripsRegistry,
  type RegistryCrew,
  type RegistryPosition,
  type StripsRegistryData,
} from "./stripsRegistry";
import {
  buildRegistryGeneralRows,
  collectRegistryTableFilterOptions,
  registryGeneralRowNote,
  viewRegistryCrews,
  viewRegistryGeneralRows,
  viewRegistryPositions,
  type RegistryAssignmentState,
  type RegistryCrewSortKey,
  type RegistryGeneralSortKey,
  type RegistryPositionSortKey,
  type RegistrySortDirection,
  type RegistryTableFilters,
} from "./registryTableView";

type MainTab = "data" | "report";
type DataTab = "general" | "crews" | "positions";
type RecordEditor =
  | { kind: "crew"; isNew: boolean; value: RegistryCrew }
  | { kind: "position"; isNew: boolean; value: RegistryPosition };

interface AssignmentEditor {
  id: string | null;
  crewId: string;
  positionId: string;
}

interface PendingConfirmation {
  title: string;
  label: string;
  action: () => void;
  confirmLabel?: string;
  tone?: "danger" | "primary";
}

interface RegistryFilterState {
  strip: string;
  unit: string;
  uavType: string;
  crewReadiness: string;
  positionReadiness: string;
  assignmentState: RegistryAssignmentState | "";
}

interface RegistrySortState<Key extends string> {
  key: Key;
  direction: RegistrySortDirection;
}

interface RegistrySortStates {
  general: RegistrySortState<RegistryGeneralSortKey>;
  crews: RegistrySortState<RegistryCrewSortKey>;
  positions: RegistrySortState<RegistryPositionSortKey>;
}

const TABLE_ZOOM_STEPS = [60, 70, 80, 90, 100, 110, 125] as const;
const UAV_OPTIONS: ReadonlyArray<CustomSelectOption<UavType>> = UAV_TYPES.map((value) => ({ value, label: value }));
const DUTY_OPTIONS: ReadonlyArray<CustomSelectOption<CrewDuty>> = [
  ...CREW_DUTIES.map((value) => ({ value, label: value })),
  { value: "Формується", label: "Формується" },
];
const INITIAL_FILTERS: RegistryFilterState = {
  strip: "",
  unit: "",
  uavType: "",
  crewReadiness: "",
  positionReadiness: "",
  assignmentState: "",
};
const INITIAL_SORTS: RegistrySortStates = {
  general: { key: "crew", direction: "asc" },
  crews: { key: "name", direction: "asc" },
  positions: { key: "name", direction: "asc" },
};
const TABLE_FILTER_DEBOUNCE_MS = 250;
const GENERAL_SORT_OPTIONS: ReadonlyArray<CustomSelectOption<RegistryGeneralSortKey>> = [
  { value: "crew", label: "Екіпаж" },
  { value: "position", label: "Позиція" },
  { value: "strip", label: "Смуга" },
  { value: "unit", label: "Підрозділ" },
  { value: "uavType", label: "Тип БпЛА" },
  { value: "crewReadiness", label: "БГ екіпажу" },
  { value: "positionReadiness", label: "БГ позиції" },
  { value: "assignmentState", label: "Стан зв’язку" },
];
const CREW_SORT_OPTIONS: ReadonlyArray<CustomSelectOption<RegistryCrewSortKey>> = [
  { value: "name", label: "Назва екіпажу" },
  { value: "unit", label: "Підрозділ" },
  { value: "uavType", label: "Тип БпЛА" },
  { value: "readiness", label: "БГ" },
  { value: "duty", label: "БЧ" },
  { value: "assets", label: "Засіб" },
  { value: "strip", label: "Смуга позиції" },
  { value: "position", label: "Позиція" },
  { value: "note", label: "Примітки" },
  { value: "assignmentState", label: "Стан зв’язку" },
];
const POSITION_SORT_OPTIONS: ReadonlyArray<CustomSelectOption<RegistryPositionSortKey>> = [
  { value: "name", label: "Назва позиції" },
  { value: "strip", label: "Смуга" },
  { value: "unit", label: "Підрозділ" },
  { value: "uavType", label: "Тип БпЛА" },
  { value: "readiness", label: "БГ" },
  { value: "bro", label: "БРО" },
  { value: "area", label: "Район" },
  { value: "direction", label: "Напрямок" },
  { value: "note", label: "Примітки" },
  { value: "assignmentState", label: "Стан зв’язку" },
];

function filterSelectOptions(values: ReadonlyArray<string>): ReadonlyArray<CustomSelectOption<string>> {
  return [{ value: "", label: "Усі" }, ...values.map((value) => ({ value, label: value }))];
}

function assignmentFilterOptions(
  tab: DataTab,
  available: ReadonlyArray<RegistryAssignmentState>,
): ReadonlyArray<CustomSelectOption<string>> {
  const labels: Record<RegistryAssignmentState, string> = {
    assigned: "Пов’язані",
    "crew-without-position": "Екіпажі без позиції",
    "position-without-crew": "Позиції без екіпажу",
  };
  return [
    { value: "", label: "Усі" },
    ...available
      .filter((state) => !(tab === "crews" && state === "position-without-crew")
        && !(tab === "positions" && state === "crew-without-position"))
      .map((state) => ({ value: state, label: labels[state] })),
  ];
}

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initialRegistryData(): StripsRegistryData {
  const reportDate = tomorrow();
  const demoRequested = import.meta.env.DEV
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("demo") === "registry";
  return demoRequested
    ? createDemoStripsRegistry(reportDate)
    : createEmptyStripsRegistry(reportDate);
}

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function messageFrom(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Не вдалося виконати операцію.";
}

function validationCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} помилок`;
  if (last === 1) return `${count} помилка`;
  if (last >= 2 && last <= 4) return `${count} помилки`;
  return `${count} помилок`;
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk-UA");
}

function filterValueExists(values: ReadonlyArray<string>, value: string): boolean {
  return !value || values.some((option) => normalizedLabel(option) === normalizedLabel(value));
}

function reconcileRegistryFilters(
  current: RegistryFilterState,
  options: ReturnType<typeof collectRegistryTableFilterOptions>,
  tab: DataTab,
): RegistryFilterState {
  const next: RegistryFilterState = {
    strip: filterValueExists(options.strips, current.strip) ? current.strip : "",
    unit: filterValueExists(options.units, current.unit) ? current.unit : "",
    uavType: filterValueExists(options.uavTypes, current.uavType) ? current.uavType : "",
    crewReadiness: tab !== "positions" && filterValueExists(options.crewReadiness, current.crewReadiness)
      ? current.crewReadiness
      : "",
    positionReadiness: tab !== "crews" && filterValueExists(options.positionReadiness, current.positionReadiness)
      ? current.positionReadiness
      : "",
    assignmentState: current.assignmentState && !options.assignmentStates.includes(current.assignmentState)
      ? ""
      : current.assignmentState,
  };
  return Object.keys(next).every((key) => next[key as keyof RegistryFilterState] === current[key as keyof RegistryFilterState])
    ? current
    : next;
}

function statusClass(status: string): string {
  if (status === "БГ") return "status-ready";
  if (status === "Не БГ") return "status-not-ready";
  if (status === "Формується") return "status-forming";
  return "status-neutral";
}

function assignmentProblem(crew: RegistryCrew | null, position: RegistryPosition | null): string {
  if (!crew || !position) return "Оберіть екіпаж і позицію.";
  if (crew.readiness === "Формується") return "Екіпаж зі статусом «Формується» не може мати позицію.";
  if (crew.readiness && position.readiness && crew.readiness !== position.readiness) {
    return "Статус екіпажу має збігатися зі статусом позиції.";
  }
  if (crew.unit && position.unit && normalizedLabel(crew.unit) !== normalizedLabel(position.unit)) {
    return "Підрозділ екіпажу має збігатися з підрозділом позиції.";
  }
  if (crew.uavType && position.uavType && crew.uavType !== position.uavType) {
    return "Тип БпЛА екіпажу має збігатися з типом БпЛА позиції.";
  }
  return "";
}

function crewReadinessOptions(crew: RegistryCrew): ReadonlyArray<CustomSelectOption<CrewReadiness>> {
  return CREW_READINESS.map((value) => ({
    value,
    label: value === "Не БГ" ? readinessDisplay(value, crew.notReadyReason) : value,
  }));
}

function positionReadinessOptions(position: RegistryPosition): ReadonlyArray<CustomSelectOption<PositionReadiness>> {
  return POSITION_READINESS.map((value) => ({
    value,
    label: value === "Не БГ" ? readinessDisplay(value, position.notReadyReason) : value,
  }));
}

function Notification({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  return <div className={`message ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

function StatusBadge({ value, reason = "" }: { value: string; reason?: string }) {
  const label = value ? readinessDisplay(value as CrewReadiness, reason) : "Не вказано";
  return <span className={`registry-status-badge ${statusClass(value)}`} title={label}>{label}</span>;
}

function LedgerValue({ children, muted = false, title }: { children: ReactNode; muted?: boolean; title?: string }) {
  const text = typeof children === "string" ? children : undefined;
  return <span className={`registry-ledger-value${muted ? " muted" : ""}`} title={title ?? text}>{children || "—"}</span>;
}

function ConfirmationModal({ value, onCancel, onConfirm }: {
  value: PendingConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" && !event.isComposing && !event.repeat) {
        event.preventDefault();
        onConfirm();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onConfirm]);

  return (
    <div className="reason-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="reason-modal" role="dialog" aria-modal="true" aria-labelledby="registry-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="reason-modal-close" aria-label="Закрити" onClick={onCancel}><X size={18} /></button>
        <h2 id="registry-confirm-title">{value.title}</h2>
        <p>{value.label}</p>
        <div className="reason-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Скасувати</button>
          <button
            type="button"
            className={value.tone === "primary" ? "primary-button" : "secondary-button danger-button"}
            onClick={onConfirm}
          >
            {value.confirmLabel ?? "Видалити"}
          </button>
        </div>
      </section>
    </div>
  );
}

function RecordEditorModal({ editor, data, onChange, onCancel, onSave }: {
  editor: RecordEditor;
  data: StripsRegistryData;
  onChange: (editor: RecordEditor) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[role="combobox"][aria-expanded="true"]')) return;
        event.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const missingReason = editor.value.readiness === "Не БГ" && !editor.value.notReadyReason.trim();
  const history = useMemo(() => collectRegistryHistory(data), [data]);

  return (
    <div className="reason-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form className="reason-modal registry-editor-modal" onSubmit={(event) => { event.preventDefault(); if (!missingReason) onSave(); }} onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="reason-modal-close" aria-label="Закрити" onClick={onCancel}><X size={18} /></button>
        <h2>{editor.isNew ? "Новий запис" : "Редагування"}: {editor.kind === "crew" ? "екіпаж" : "позиція"}</h2>
        <p>{editor.kind === "crew" ? "Тут зберігаються лише власні дані екіпажу. Дані позиції задаються окремо." : "Тут зберігаються лише дані позиції. Екіпажі приєднуються у вкладці «Загальні»."}</p>

        {editor.kind === "crew" ? (
          <div className="registry-form-grid">
            <label className="registry-form-field"><span>Назва екіпажу</span><input autoFocus value={editor.value.name} maxLength={250} onChange={(event) => onChange({ ...editor, value: { ...editor.value, name: event.target.value } })} /></label>
            <label className="registry-form-field"><span>Підрозділ</span><RegistryHistoryInput ariaLabel="Підрозділ екіпажу" value={editor.value.unit} options={history.units} maxLength={250} onChange={(unit) => onChange({ ...editor, value: { ...editor.value, unit } })} /></label>
            <label className="registry-form-field"><span>Тип БпЛА</span><CustomSelect<UavType> portal ariaLabel="Тип БпЛА екіпажу" value={editor.value.uavType} options={UAV_OPTIONS} onChange={(uavType) => onChange({ ...editor, value: { ...editor.value, uavType } })} /></label>
            <label className="registry-form-field"><span>БГ екіпажу</span><CustomSelect<CrewReadiness> portal ariaLabel="БГ екіпажу" value={editor.value.readiness} options={crewReadinessOptions(editor.value)} onChange={(readiness) => onChange({ ...editor, value: { ...editor.value, readiness, notReadyReason: readiness === "Не БГ" ? editor.value.notReadyReason : "", duty: readiness === "Формується" ? "Формується" : editor.value.duty === "Формується" ? "" : editor.value.duty } })} /></label>
            {editor.value.readiness === "Не БГ" && <label className="registry-form-field registry-form-span-2"><span>Причина «Не БГ»</span><textarea autoFocus value={editor.value.notReadyReason} maxLength={500} rows={3} placeholder="Причина обов’язкова" onChange={(event) => onChange({ ...editor, value: { ...editor.value, notReadyReason: event.target.value } })} /></label>}
            <label className="registry-form-field"><span>БЧ екіпажу</span><CustomSelect<CrewDuty> portal ariaLabel="БЧ екіпажу" value={editor.value.duty} options={DUTY_OPTIONS} disabled={editor.value.readiness === "Формується"} onChange={(duty) => onChange({ ...editor, value: { ...editor.value, duty } })} /></label>
            <label className="registry-form-field"><span>Засіб</span><input value={editor.value.assets} maxLength={500} placeholder="Через кому" onChange={(event) => onChange({ ...editor, value: { ...editor.value, assets: event.target.value } })} /></label>
            <label className="registry-form-field registry-form-span-2"><span>Примітки</span><textarea value={editor.value.note} maxLength={1000} rows={3} onChange={(event) => onChange({ ...editor, value: { ...editor.value, note: event.target.value } })} /></label>
          </div>
        ) : (
          <div className="registry-form-grid">
            <label className="registry-form-field"><span>Назва позиції</span><input autoFocus value={editor.value.name} maxLength={250} onChange={(event) => onChange({ ...editor, value: { ...editor.value, name: event.target.value } })} /></label>
            <label className="registry-form-field"><span>Смуга</span><RegistryHistoryInput ariaLabel="Смуга позиції" value={editor.value.strip} options={history.strips} maxLength={200} onChange={(strip) => onChange({ ...editor, value: { ...editor.value, strip } })} /></label>
            <label className="registry-form-field"><span>Підрозділ</span><RegistryHistoryInput ariaLabel="Підрозділ позиції" value={editor.value.unit} options={history.units} maxLength={250} onChange={(unit) => onChange({ ...editor, value: { ...editor.value, unit } })} /></label>
            <label className="registry-form-field"><span>Тип БпЛА</span><CustomSelect<UavType> portal ariaLabel="Тип БпЛА позиції" value={editor.value.uavType} options={UAV_OPTIONS} onChange={(uavType) => onChange({ ...editor, value: { ...editor.value, uavType } })} /></label>
            <label className="registry-form-field"><span>БГ позиції</span><CustomSelect<PositionReadiness> portal ariaLabel="БГ позиції" value={editor.value.readiness} options={positionReadinessOptions(editor.value)} onChange={(readiness) => onChange({ ...editor, value: { ...editor.value, readiness, notReadyReason: readiness === "Не БГ" ? editor.value.notReadyReason : "" } })} /></label>
            <label className="registry-form-field"><span>БРО</span><RegistryHistoryInput ariaLabel="БРО позиції" value={editor.value.bro} options={history.bros} maxLength={250} onChange={(bro) => onChange({ ...editor, value: { ...editor.value, bro } })} /></label>
            {editor.value.readiness === "Не БГ" && <label className="registry-form-field registry-form-span-2"><span>Причина «Не БГ»</span><textarea autoFocus value={editor.value.notReadyReason} maxLength={500} rows={3} placeholder="Причина обов’язкова" onChange={(event) => onChange({ ...editor, value: { ...editor.value, notReadyReason: event.target.value } })} /></label>}
            <label className="registry-form-field"><span>Район</span><input value={editor.value.area} maxLength={250} onChange={(event) => onChange({ ...editor, value: { ...editor.value, area: upperUk(event.target.value) } })} /></label>
            <label className="registry-form-field"><span>Напрямок роботи</span><textarea value={editor.value.direction} maxLength={500} rows={3} onChange={(event) => onChange({ ...editor, value: { ...editor.value, direction: event.target.value } })} /></label>
            <label className="registry-form-field registry-form-span-2"><span>Примітки</span><textarea value={editor.value.note} maxLength={1000} rows={3} onChange={(event) => onChange({ ...editor, value: { ...editor.value, note: event.target.value } })} /></label>
          </div>
        )}

        {missingReason && <p className="registry-form-error">Без причини статус «Не БГ» не буде збережено.</p>}
        <div className="reason-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Скасувати</button>
          <button type="submit" className="primary-button" disabled={missingReason}>Зберегти</button>
        </div>
      </form>
    </div>
  );
}

function AssignmentEditorModal({ value, data, onChange, onCancel, onSave }: {
  value: AssignmentEditor;
  data: StripsRegistryData;
  onChange: (value: AssignmentEditor) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const crew = data.crews.find((item) => item.id === value.crewId) ?? null;
  const position = data.positions.find((item) => item.id === value.positionId) ?? null;
  const usedCrewIds = new Set(data.assignments.filter((item) => item.id !== value.id).map((item) => item.crewId));
  const crewOptions: ReadonlyArray<CustomSelectOption<string>> = data.crews.map((item) => ({
    value: item.id,
    label: `${item.name || "Без назви"} — ${item.unit || "підрозділ не вказано"}`,
    disabled: usedCrewIds.has(item.id),
  }));
  const positionOptions: ReadonlyArray<CustomSelectOption<string>> = data.positions.map((item) => {
    const incompatibility = crew ? assignmentProblem(crew, item) : "";
    return {
      value: item.id,
      label: `${item.name || "Без назви"} — ${item.strip || "смуга не вказана"}${incompatibility ? ` — недоступно: ${incompatibility}` : ""}`,
      disabled: Boolean(incompatibility),
    };
  });
  const problem = assignmentProblem(crew, position);
  const compatiblePositionCount = crew
    ? data.positions.filter((item) => !assignmentProblem(crew, item)).length
    : 0;
  const displayedProblem = crew && !position && data.positions.length > 0 && compatiblePositionCount === 0
    ? "Для цього екіпажу немає сумісних позицій. Мають збігатися статус, підрозділ і тип БпЛА."
    : problem;

  return (
    <div className="reason-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form className="reason-modal registry-editor-modal registry-link-editor" onSubmit={(event) => { event.preventDefault(); if (!problem) onSave(); }} onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="reason-modal-close" aria-label="Закрити" onClick={onCancel}><X size={18} /></button>
        <h2>{value.id ? "Змінити зв’язок" : "Пов’язати екіпаж із позицією"}</h2>
        <p>Екіпаж і позиція залишаються окремими записами. Тут зберігається лише зв’язок між ними.</p>
        <div className="registry-form-grid">
          <label className="registry-form-field"><span>Екіпаж</span><CustomSelect<string> portal ariaLabel="Оберіть екіпаж" value={value.crewId} options={crewOptions} onChange={(crewId) => onChange({ ...value, crewId, positionId: assignmentProblem(data.crews.find((item) => item.id === crewId) ?? null, position) ? "" : value.positionId })} /></label>
          <label className="registry-form-field"><span>Позиція</span><CustomSelect<string> portal ariaLabel="Оберіть позицію" value={value.positionId} options={positionOptions} disabled={!crew} onChange={(positionId) => onChange({ ...value, positionId })} /></label>
        </div>
        {displayedProblem && <p className="registry-form-error">{displayedProblem}</p>}
        <div className="reason-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Скасувати</button>
          <button type="submit" className="primary-button" disabled={Boolean(problem)}>Зберегти зв’язок</button>
        </div>
      </form>
    </div>
  );
}

function RegistryTableControls({
  tab,
  search,
  filters,
  filterOptions,
  sortKey,
  defaultSortKey,
  sortDirection,
  sortOptions,
  onSearch,
  onFilters,
  onSortKey,
  onSortDirection,
  onReset,
}: {
  tab: DataTab;
  search: string;
  filters: RegistryFilterState;
  filterOptions: ReturnType<typeof collectRegistryTableFilterOptions>;
  sortKey: string;
  defaultSortKey: string;
  sortDirection: RegistrySortDirection;
  sortOptions: ReadonlyArray<CustomSelectOption<string>>;
  onSearch: (value: string) => void;
  onFilters: (value: RegistryFilterState) => void;
  onSortKey: (value: string) => void;
  onSortDirection: () => void;
  onReset: () => void;
}) {
  const hasActiveFilters = Boolean(
    search.trim()
    || filters.strip
    || filters.unit
    || filters.uavType
    || filters.crewReadiness
    || filters.positionReadiness
    || filters.assignmentState,
  );

  return (
    <div className="registry-view-controls" aria-label="Пошук, сортування і фільтри">
      <label className="registry-search-control">
        <span>Пошук</span>
        <span className="registry-search-input"><Search size={16} aria-hidden="true" /><input value={search} placeholder="Назва, район, БРО, засіб…" onChange={(event) => onSearch(event.target.value)} /></span>
      </label>
      <label className="registry-filter-control"><span>Смуга</span><CustomSelect<string> portal ariaLabel="Фільтр за смугою" value={filters.strip} options={filterSelectOptions(filterOptions.strips)} onChange={(strip) => onFilters({ ...filters, strip })} /></label>
      <label className="registry-filter-control"><span>Підрозділ</span><CustomSelect<string> portal ariaLabel="Фільтр за підрозділом" value={filters.unit} options={filterSelectOptions(filterOptions.units)} onChange={(unit) => onFilters({ ...filters, unit })} /></label>
      <label className="registry-filter-control"><span>Тип БпЛА</span><CustomSelect<string> portal ariaLabel="Фільтр за типом БпЛА" value={filters.uavType} options={filterSelectOptions(filterOptions.uavTypes)} onChange={(uavType) => onFilters({ ...filters, uavType })} /></label>
      {(tab === "general" || tab === "crews") && <label className="registry-filter-control"><span>БГ екіпажу</span><CustomSelect<string> portal ariaLabel="Фільтр за готовністю екіпажу" value={filters.crewReadiness} options={filterSelectOptions(filterOptions.crewReadiness)} onChange={(crewReadiness) => onFilters({ ...filters, crewReadiness })} /></label>}
      {(tab === "general" || tab === "positions") && <label className="registry-filter-control"><span>БГ позиції</span><CustomSelect<string> portal ariaLabel="Фільтр за готовністю позиції" value={filters.positionReadiness} options={filterSelectOptions(filterOptions.positionReadiness)} onChange={(positionReadiness) => onFilters({ ...filters, positionReadiness })} /></label>}
      <label className="registry-filter-control"><span>Зв’язок</span><CustomSelect<string> portal ariaLabel="Фільтр за станом зв’язку" value={filters.assignmentState} options={assignmentFilterOptions(tab, filterOptions.assignmentStates)} onChange={(assignmentState) => onFilters({ ...filters, assignmentState: assignmentState as RegistryAssignmentState | "" })} /></label>
      <label className="registry-filter-control registry-sort-control"><span>Сортування</span><CustomSelect<string> portal ariaLabel="Поле сортування" value={sortKey} options={sortOptions} onChange={onSortKey} /></label>
      <button type="button" className="registry-sort-direction" title={sortDirection === "asc" ? "За зростанням" : "За спаданням"} aria-label={sortDirection === "asc" ? "Сортувати за спаданням" : "Сортувати за зростанням"} onClick={onSortDirection}>
        {sortDirection === "asc" ? <ArrowUp size={17} /> : <ArrowDown size={17} />}
      </button>
      <button
        type="button"
        className="registry-reset-filters"
        title="Скинути пошук, фільтри і сортування"
        aria-label="Скинути пошук, фільтри і сортування"
        disabled={!hasActiveFilters && sortKey === defaultSortKey && sortDirection === "asc"}
        onClick={onReset}
      ><RotateCcw size={17} /></button>
    </div>
  );
}

export default function StripsRegistryWorkspace() {
  const [data, setData] = useState<StripsRegistryData>(initialRegistryData);
  const [mainTab, setMainTab] = useState<MainTab>("data");
  const [dataTab, setDataTab] = useState<DataTab>("general");
  const [editor, setEditor] = useState<RecordEditor | null>(null);
  const [assignmentEditor, setAssignmentEditor] = useState<AssignmentEditor | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [tableZoom, setTableZoom] = useState(80);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [donePath, setDonePath] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saved" | "saving" | "error">("saved");
  const [tableSearch, setTableSearch] = useState("");
  const [tableFilters, setTableFilters] = useState<RegistryFilterState>(INITIAL_FILTERS);
  const [appliedTableSearch, setAppliedTableSearch] = useState("");
  const [appliedTableFilters, setAppliedTableFilters] = useState<RegistryFilterState>(INITIAL_FILTERS);
  const [tableSorts, setTableSorts] = useState<RegistrySortStates>(INITIAL_SORTS);
  const contentRef = useRef<HTMLDivElement>(null);
  const tableViewDebounceRef = useRef<number | null>(null);
  const tableViewGenerationRef = useRef(0);
  const tauriAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const modalOpen = Boolean(editor || assignmentEditor || pendingConfirmation);
  const report = useMemo(() => registryToStripsReport(data), [data]);
  const validationErrors = useMemo(() => {
    const registryProblems = validateStripsRegistry(data);
    return registryProblems.length > 0 ? registryProblems : validateStripsReportErrors(report);
  }, [data, report]);

  const generalRows = useMemo(() => buildRegistryGeneralRows(data), [data]);
  const tableFilterOptions = useMemo(() => collectRegistryTableFilterOptions(data, dataTab), [data, dataTab]);
  const sharedViewFilters = useMemo<RegistryTableFilters>(() => ({
    strips: appliedTableFilters.strip ? [appliedTableFilters.strip] : undefined,
    units: appliedTableFilters.unit ? [appliedTableFilters.unit] : undefined,
    uavTypes: appliedTableFilters.uavType ? [appliedTableFilters.uavType] : undefined,
    assignmentStates: appliedTableFilters.assignmentState ? [appliedTableFilters.assignmentState] : undefined,
  }), [appliedTableFilters.assignmentState, appliedTableFilters.strip, appliedTableFilters.uavType, appliedTableFilters.unit]);
  const visibleGeneralRows = useMemo(() => viewRegistryGeneralRows(data, {
    search: appliedTableSearch,
    filters: {
      ...sharedViewFilters,
      crewReadiness: appliedTableFilters.crewReadiness ? [appliedTableFilters.crewReadiness] : undefined,
      positionReadiness: appliedTableFilters.positionReadiness ? [appliedTableFilters.positionReadiness] : undefined,
    },
    sort: tableSorts.general,
  }), [appliedTableFilters.crewReadiness, appliedTableFilters.positionReadiness, appliedTableSearch, data, sharedViewFilters, tableSorts.general]);
  const visibleCrews = useMemo(() => viewRegistryCrews(data, {
    search: appliedTableSearch,
    filters: {
      ...sharedViewFilters,
      crewReadiness: appliedTableFilters.crewReadiness ? [appliedTableFilters.crewReadiness] : undefined,
    },
    sort: tableSorts.crews,
  }), [appliedTableFilters.crewReadiness, appliedTableSearch, data, sharedViewFilters, tableSorts.crews]);
  const visiblePositions = useMemo(() => viewRegistryPositions(data, {
    search: appliedTableSearch,
    filters: {
      ...sharedViewFilters,
      positionReadiness: appliedTableFilters.positionReadiness ? [appliedTableFilters.positionReadiness] : undefined,
    },
    sort: tableSorts.positions,
  }), [appliedTableFilters.positionReadiness, appliedTableSearch, data, sharedViewFilters, tableSorts.positions]);

  useEffect(() => {
    setTableFilters((current) => reconcileRegistryFilters(current, tableFilterOptions, dataTab));
    setAppliedTableFilters((current) => reconcileRegistryFilters(current, tableFilterOptions, dataTab));
  }, [dataTab, tableFilterOptions]);

  useEffect(() => {
    const generation = ++tableViewGenerationRef.current;
    if (tableViewDebounceRef.current !== null) window.clearTimeout(tableViewDebounceRef.current);
    const timeout = window.setTimeout(() => {
      if (generation !== tableViewGenerationRef.current) return;
      setAppliedTableSearch(tableSearch);
      setAppliedTableFilters(tableFilters);
      tableViewDebounceRef.current = null;
    }, TABLE_FILTER_DEBOUNCE_MS);
    tableViewDebounceRef.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (tableViewDebounceRef.current === timeout) tableViewDebounceRef.current = null;
    };
  }, [tableFilters, tableSearch]);

  useEffect(() => {
    if (!tauriAvailable) {
      setDraftReady(true);
      return;
    }
    const seedDemoWhenEmpty = import.meta.env.DEV;
    let disposed = false;
    void invoke<string | null>("load_workspace_draft", { variant: "strips-registry" })
      .then((payload) => {
        if (disposed) return;
        if (!payload) {
          setData(seedDemoWhenEmpty
            ? createDemoStripsRegistry(tomorrow())
            : createEmptyStripsRegistry(tomorrow()));
          setDraftReady(true);
          return;
        }
        const restored = normalizeStripsRegistry(JSON.parse(payload));
        if (!restored) {
          setDraftStatus("error");
          return;
        }
        setData(seedDemoWhenEmpty && isEffectivelyEmptyStripsRegistry(restored)
          ? createDemoStripsRegistry(restored.reportDate)
          : restored);
        setDraftReady(true);
      })
      .catch(() => { if (!disposed) setDraftStatus("error"); });
    return () => { disposed = true; };
  }, [tauriAvailable]);

  useEffect(() => {
    if (!tauriAvailable || !draftReady) return;
    setDraftStatus("saving");
    const timeout = window.setTimeout(() => {
      void invoke("save_workspace_draft", { variant: "strips-registry", payload: JSON.stringify(data) })
        .then(() => setDraftStatus("saved"))
        .catch(() => setDraftStatus("error"));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [data, draftReady, tauriAvailable]);

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
  useEffect(() => {
    if (!donePath) return;
    const timeout = window.setTimeout(() => setDonePath(""), 10_000);
    return () => window.clearTimeout(timeout);
  }, [donePath]);
  useEffect(() => {
    if (!contentRef.current) return;
    contentRef.current.scrollLeft = 0;
    contentRef.current.scrollTop = 0;
  }, [mainTab, dataTab]);

  function changeZoom(direction: -1 | 1) {
    const current = TABLE_ZOOM_STEPS.findIndex((value) => value === tableZoom);
    const next = Math.max(0, Math.min(TABLE_ZOOM_STEPS.length - 1, current + direction));
    setTableZoom(TABLE_ZOOM_STEPS[next]);
  }

  function applyTableViewImmediately(search: string, filters: RegistryFilterState) {
    tableViewGenerationRef.current += 1;
    if (tableViewDebounceRef.current !== null) {
      window.clearTimeout(tableViewDebounceRef.current);
      tableViewDebounceRef.current = null;
    }
    setTableSearch(search);
    setTableFilters(filters);
    setAppliedTableSearch(search);
    setAppliedTableFilters(filters);
  }

  function saveRecordEditor() {
    if (!editor) return;
    if (editor.kind === "crew") {
      const crew = { ...editor.value, assets: editor.value.assets.split(",").map((item) => item.trim()).filter(Boolean).join(", ") };
      const position = positionForCrew(data, crew.id);
      const detached = Boolean(position && assignmentProblem(crew, position));
      setData((current) => ({
        ...current,
        crews: editor.isNew ? [...current.crews, crew] : current.crews.map((item) => item.id === crew.id ? crew : item),
        assignments: detached ? current.assignments.filter((item) => item.crewId !== crew.id) : current.assignments,
      }));
      if (detached) setNotice(`Екіпаж «${crew.name || "Без назви"}» відкріплено від несумісної позиції.`);
    } else {
      const position = { ...editor.value, area: upperUk(editor.value.area) };
      const detachedIds = new Set(
        data.assignments
          .filter((assignment) => assignment.positionId === position.id)
          .filter((assignment) => assignmentProblem(data.crews.find((crew) => crew.id === assignment.crewId) ?? null, position))
          .map((assignment) => assignment.id),
      );
      setData((current) => ({
        ...current,
        positions: editor.isNew ? [...current.positions, position] : current.positions.map((item) => item.id === position.id ? position : item),
        assignments: current.assignments.filter((item) => !detachedIds.has(item.id)),
      }));
      if (detachedIds.size > 0) setNotice(`Від позиції «${position.name || "Без назви"}» відкріплено несумісні екіпажі.`);
    }
    setEditor(null);
  }

  function saveAssignmentEditor() {
    if (!assignmentEditor) return;
    const crew = data.crews.find((item) => item.id === assignmentEditor.crewId) ?? null;
    const position = data.positions.find((item) => item.id === assignmentEditor.positionId) ?? null;
    const problem = assignmentProblem(crew, position);
    if (problem) {
      setError(problem);
      return;
    }
    const duplicate = data.assignments.some((item) => item.id !== assignmentEditor.id && item.crewId === assignmentEditor.crewId);
    if (duplicate) {
      setError("Цей екіпаж уже має позицію.");
      return;
    }
    setData((current) => {
      if (assignmentEditor.id) {
        return { ...current, assignments: current.assignments.map((item) => item.id === assignmentEditor.id ? { ...item, crewId: assignmentEditor.crewId, positionId: assignmentEditor.positionId } : item) };
      }
      return { ...current, assignments: [...current.assignments, { ...createRegistryAssignment(), crewId: assignmentEditor.crewId, positionId: assignmentEditor.positionId }] };
    });
    setAssignmentEditor(null);
  }

  function runConfirmation() {
    const action = pendingConfirmation?.action;
    setPendingConfirmation(null);
    action?.();
  }

  async function exportWorkbook() {
    if (validationErrors.length > 0) {
      setError(`Виправте всі помилки перед експортом (${validationErrors.length}):\n${validationErrors.map((problem) => `• ${problem}`).join("\n")}`);
      return;
    }
    const outputPath = await save({
      title: "Зберегти позиції по смугах",
      defaultPath: `Позиції по смугах ${formatDate(data.reportDate)}.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!outputPath) return;
    setBusy(true);
    setError("");
    setDonePath("");
    try {
      const saved = await invoke<string>("export_strips_workbook", {
        request: {
          ...report,
          separateNotes: true,
          hideUnlinkedSummaryCaption: true,
          outputPath,
        },
      });
      setDonePath(saved);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importWorkbook() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Excel позицій по смугах", extensions: ["xlsx"] }],
      title: "Імпортувати позиції та екіпажі",
    });
    if (!selected || Array.isArray(selected)) return;

    setBusy(true);
    setError("");
    setDonePath("");
    try {
      const importedValue = await invoke<unknown>("import_strips_registry", { path: selected });
      const parsedValue = typeof importedValue === "string" ? JSON.parse(importedValue) : importedValue;
      const imported = normalizeStripsRegistry(parsedValue);
      if (!imported) throw new Error("Excel-файл має некоректну структуру даних.");

      const applyImport = () => {
        setData(imported);
        setMainTab("data");
        setDataTab("general");
        applyTableViewImmediately("", INITIAL_FILTERS);
        setTableSorts(INITIAL_SORTS);
        setNotice(`Імпортовано: ${imported.crews.length} екіпажів, ${imported.positions.length} позицій, ${imported.assignments.length} зв’язків.`);
      };
      if (isEffectivelyEmptyStripsRegistry(data)) {
        applyImport();
      } else {
        setPendingConfirmation({
          title: "Замінити поточні дані?",
          label: `У файлі знайдено ${imported.crews.length} екіпажів, ${imported.positions.length} позицій і ${imported.assignments.length} зв’язків. Поточну чернетку буде замінено після підтвердження.`,
          confirmLabel: "Імпортувати",
          tone: "primary",
          action: applyImport,
        });
      }
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  const unassignedCrewCount = data.crews.filter((crew) => !data.assignments.some((item) => item.crewId === crew.id)).length;
  const emptyPositionCount = data.positions.filter((position) => !data.assignments.some((item) => item.positionId === position.id)).length;
  const activeSort = tableSorts[dataTab];
  const activeSortOptions = (dataTab === "general"
    ? GENERAL_SORT_OPTIONS
    : dataTab === "crews"
      ? CREW_SORT_OPTIONS
      : POSITION_SORT_OPTIONS) as ReadonlyArray<CustomSelectOption<string>>;
  const activeDefaultSortKey = dataTab === "general" ? "crew" : "name";
  const activeShownCount = dataTab === "general"
    ? visibleGeneralRows.length
    : dataTab === "crews"
      ? visibleCrews.length
      : visiblePositions.length;
  const activeTotalCount = dataTab === "general"
    ? generalRows.length
    : dataTab === "crews"
      ? data.crews.length
      : data.positions.length;

  function changeActiveSortKey(key: string) {
    setTableSorts((current) => {
      if (dataTab === "general") return { ...current, general: { ...current.general, key: key as RegistryGeneralSortKey } };
      if (dataTab === "crews") return { ...current, crews: { ...current.crews, key: key as RegistryCrewSortKey } };
      return { ...current, positions: { ...current.positions, key: key as RegistryPositionSortKey } };
    });
  }

  function toggleActiveSortDirection() {
    setTableSorts((current) => {
      if (dataTab === "general") return { ...current, general: { ...current.general, direction: current.general.direction === "asc" ? "desc" : "asc" } };
      if (dataTab === "crews") return { ...current, crews: { ...current.crews, direction: current.crews.direction === "asc" ? "desc" : "asc" } };
      return { ...current, positions: { ...current.positions, direction: current.positions.direction === "asc" ? "desc" : "asc" } };
    });
  }

  function resetTableView() {
    applyTableViewImmediately("", INITIAL_FILTERS);
    setTableSorts(INITIAL_SORTS);
  }

  function changeDataTab(tab: DataTab) {
    setDataTab(tab);
    const options = collectRegistryTableFilterOptions(data, tab);
    const filters = reconcileRegistryFilters(tableFilters, options, tab);
    applyTableViewImmediately(tableSearch, filters);
  }

  return (
    <main className={`app-shell strips-shell registry-shell${modalOpen ? " registry-modal-open" : ""}`}>
      {error && <Notification kind="error">{error}</Notification>}
      {notice && <Notification kind="success">{notice}</Notification>}
      {donePath && <Notification kind="success">Файл збережено: {donePath}</Notification>}
      {editor && <RecordEditorModal editor={editor} data={data} onChange={setEditor} onCancel={() => setEditor(null)} onSave={saveRecordEditor} />}
      {assignmentEditor && <AssignmentEditorModal value={assignmentEditor} data={data} onChange={setAssignmentEditor} onCancel={() => setAssignmentEditor(null)} onSave={saveAssignmentEditor} />}
      {pendingConfirmation && <ConfirmationModal value={pendingConfirmation} onCancel={() => setPendingConfirmation(null)} onConfirm={runConfirmation} />}

      <section className="workspace-panel registry-panel">
        <div className="registry-toolbar">
          <nav className="registry-tabs registry-main-tabs" aria-label="Основні розділи">
            <button type="button" className={mainTab === "data" ? "active" : ""} onClick={() => setMainTab("data")}>Дані</button>
            <button type="button" className={mainTab === "report" ? "active" : ""} onClick={() => setMainTab("report")}>Загальна таблиця</button>
          </nav>
          <div className="registry-toolbar-controls">
            {tauriAvailable && <button type="button" className="secondary-button registry-import-button" disabled={busy} onClick={importWorkbook}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <FileUp size={16} />} Імпорт XLSX
            </button>}
            <label>Дата звіту<input type="date" value={data.reportDate} onChange={(event) => setData((current) => ({ ...current, reportDate: event.target.value }))} /></label>
            {mainTab === "report" && <div className="bcs-zoom-control" aria-label="Масштаб таблиці">
              <span>Масштаб</span>
              <button type="button" aria-label="Зменшити масштаб" disabled={tableZoom === TABLE_ZOOM_STEPS[0]} onClick={() => changeZoom(-1)}><Minus size={15} /></button>
              <output>{tableZoom}%</output>
              <button type="button" aria-label="Збільшити масштаб" disabled={tableZoom === TABLE_ZOOM_STEPS[TABLE_ZOOM_STEPS.length - 1]} onClick={() => changeZoom(1)}><Plus size={15} /></button>
            </div>}
          </div>
        </div>

        {mainTab === "data" && <nav className="registry-subtabs" aria-label="Розділи даних">
          <button type="button" className={dataTab === "general" ? "active" : ""} onClick={() => changeDataTab("general")}>Загальні <span>{generalRows.length}</span></button>
          <button type="button" className={dataTab === "crews" ? "active" : ""} onClick={() => changeDataTab("crews")}>Екіпажі <span>{data.crews.length}</span></button>
          <button type="button" className={dataTab === "positions" ? "active" : ""} onClick={() => changeDataTab("positions")}>Позиції <span>{data.positions.length}</span></button>
        </nav>}

        <div ref={contentRef} className="registry-content-scroll">
          {mainTab === "data" && <section className="registry-data-content">
            <RegistryTableControls
              tab={dataTab}
              search={tableSearch}
              filters={tableFilters}
              filterOptions={tableFilterOptions}
              sortKey={activeSort.key}
              defaultSortKey={activeDefaultSortKey}
              sortDirection={activeSort.direction}
              sortOptions={activeSortOptions}
              onSearch={setTableSearch}
              onFilters={setTableFilters}
              onSortKey={changeActiveSortKey}
              onSortDirection={toggleActiveSortDirection}
              onReset={resetTableView}
            />
            {dataTab === "general" && <>
              <div className="registry-section-heading">
                <div><h1>Загальні дані</h1><p>Тут екіпажі та позиції поєднуються. Самі записи залишаються окремими.</p></div>
                <button type="button" className="secondary-button" disabled={unassignedCrewCount === 0 || data.positions.length === 0} onClick={() => setAssignmentEditor({ id: null, crewId: "", positionId: "" })}><Link2 size={16} /> Пов’язати екіпаж і позицію</button>
              </div>
              <div className="registry-overview-cards">
                <span><b>{data.crews.length}</b> екіпажів</span><span><b>{data.positions.length}</b> позицій</span>
                <span><b>{unassignedCrewCount}</b> без позиції</span><span><b>{emptyPositionCount}</b> без екіпажу</span>
              </div>
              <div className="registry-ledger-wrap"><table className="registry-records-table registry-general-table">
                <thead><tr><th>№</th><th>Екіпаж</th><th>Позиція</th><th>Смуга</th><th>Підрозділ</th><th>Тип БпЛА</th><th>БГ екіпажу</th><th>БЧ</th><th>Засіб</th><th>БГ позиції</th><th>БРО</th><th>Район</th><th>Напрямок</th><th>Примітки</th><th>Дії</th></tr></thead>
                <tbody>
                  {visibleGeneralRows.length === 0 && <tr><td colSpan={15} className="registry-empty-cell">{generalRows.length === 0 ? "Спочатку додайте екіпажі та позиції у відповідних вкладках." : "За заданими умовами нічого не знайдено."}</td></tr>}
                  {visibleGeneralRows.map((row, index) => <tr key={row.key}>
                    <td>{index + 1}</td>
                    <td><LedgerValue muted={!row.crew}>{row.crew?.name || "Позиція без екіпажу"}</LedgerValue></td>
                    <td><LedgerValue muted={!row.position}>{row.position?.name || "Екіпаж без позиції"}</LedgerValue></td>
                    <td><LedgerValue>{row.position?.strip}</LedgerValue></td>
                    <td><LedgerValue>{row.crew?.unit || row.position?.unit}</LedgerValue></td>
                    <td><LedgerValue>{row.crew?.uavType || row.position?.uavType}</LedgerValue></td>
                    <td>{row.crew ? <StatusBadge value={row.crew.readiness} reason={row.crew.notReadyReason} /> : "—"}</td>
                    <td><LedgerValue>{row.crew?.duty}</LedgerValue></td>
                    <td><LedgerValue>{row.crew?.assets}</LedgerValue></td>
                    <td>{row.position ? <StatusBadge value={row.position.readiness} reason={row.position.notReadyReason} /> : "—"}</td>
                    <td><LedgerValue>{row.position?.bro}</LedgerValue></td><td><LedgerValue>{row.position?.area}</LedgerValue></td><td><LedgerValue>{row.position?.direction}</LedgerValue></td>
                    <td><LedgerValue>{registryGeneralRowNote(row)}</LedgerValue></td>
                    <td className="registry-actions-cell">
                      <div className="registry-action-buttons">
                        <button type="button" className="registry-icon-button" title={row.assignment ? "Змінити зв’язок" : "Призначити"} aria-label={row.assignment ? "Змінити зв’язок" : "Призначити"} disabled={data.positions.length === 0 || (!row.crew && unassignedCrewCount === 0)} onClick={() => setAssignmentEditor({ id: row.assignment?.id ?? null, crewId: row.crew?.id ?? "", positionId: row.position?.id ?? "" })}>{row.assignment ? <Pencil size={16} /> : <Link2 size={16} />}</button>
                        {row.assignment && <button type="button" className="registry-icon-button danger" title="Відкріпити" aria-label="Відкріпити" onClick={() => setData((current) => ({ ...current, assignments: current.assignments.filter((item) => item.id !== row.assignment?.id) }))}><Unlink2 size={16} /></button>}
                      </div>
                    </td>
                  </tr>)}
                </tbody>
              </table></div>
            </>}

            {dataTab === "crews" && <>
              <div className="registry-section-heading">
                <div><h1>Екіпажі</h1><p>Лише дані екіпажів. Позиція, смуга, БРО, район і напрямок тут не зберігаються.</p></div>
                <button type="button" className="secondary-button" onClick={() => setEditor({ kind: "crew", isNew: true, value: createRegistryCrew() })}><Plus size={16} /> Додати екіпаж</button>
              </div>
              <div className="registry-ledger-wrap"><table className="registry-records-table registry-crews-ledger">
                <thead><tr><th>№</th><th>Назва екіпажу</th><th>Підрозділ</th><th>Тип БпЛА</th><th>БГ</th><th>БЧ</th><th>Засіб</th><th>Примітки</th><th>Дії</th></tr></thead>
                <tbody>
                  {visibleCrews.length === 0 && <tr><td colSpan={9} className="registry-empty-cell">{data.crews.length === 0 ? "Додайте перший екіпаж." : "За заданими умовами нічого не знайдено."}</td></tr>}
                  {visibleCrews.map((crew, index) => <tr key={crew.id}>
                    <td>{index + 1}</td><td><LedgerValue>{crew.name}</LedgerValue></td><td><LedgerValue>{crew.unit}</LedgerValue></td><td><LedgerValue>{crew.uavType}</LedgerValue></td>
                    <td><StatusBadge value={crew.readiness} reason={crew.notReadyReason} /></td><td><LedgerValue>{crew.duty}</LedgerValue></td><td><LedgerValue>{crew.assets}</LedgerValue></td><td><LedgerValue>{crew.note}</LedgerValue></td>
                    <td className="registry-actions-cell"><div className="registry-action-buttons">
                      <button type="button" className="registry-icon-button" title="Редагувати екіпаж" aria-label="Редагувати екіпаж" onClick={() => setEditor({ kind: "crew", isNew: false, value: { ...crew } })}><Pencil size={16} /></button>
                      <button type="button" className="registry-icon-button danger" title="Видалити екіпаж" aria-label="Видалити екіпаж" onClick={() => setPendingConfirmation({ title: "Видалити екіпаж?", label: `Екіпаж «${crew.name || "Без назви"}» і його зв’язок із позицією буде видалено.`, action: () => setData((current) => ({ ...current, crews: current.crews.filter((item) => item.id !== crew.id), assignments: current.assignments.filter((item) => item.crewId !== crew.id) })) })}><Trash2 size={16} /></button>
                    </div></td>
                  </tr>)}
                </tbody>
              </table></div>
            </>}

            {dataTab === "positions" && <>
              <div className="registry-section-heading">
                <div><h1>Позиції</h1><p>Лише дані позицій. Екіпажі приєднуються окремо у вкладці «Загальні».</p></div>
                <button type="button" className="secondary-button" onClick={() => setEditor({ kind: "position", isNew: true, value: createRegistryPosition() })}><Plus size={16} /> Додати позицію</button>
              </div>
              <div className="registry-ledger-wrap"><table className="registry-records-table registry-positions-ledger">
                <thead><tr><th>№</th><th>Назва позиції</th><th>Смуга</th><th>Підрозділ</th><th>Тип БпЛА</th><th>БГ</th><th>БРО</th><th>Район</th><th>Напрямок роботи</th><th>Примітки</th><th>Дії</th></tr></thead>
                <tbody>
                  {visiblePositions.length === 0 && <tr><td colSpan={11} className="registry-empty-cell">{data.positions.length === 0 ? "Додайте першу позицію." : "За заданими умовами нічого не знайдено."}</td></tr>}
                  {visiblePositions.map((position, index) => <tr key={position.id}>
                    <td>{index + 1}</td><td><LedgerValue>{position.name}</LedgerValue></td><td><LedgerValue>{position.strip}</LedgerValue></td><td><LedgerValue>{position.unit}</LedgerValue></td><td><LedgerValue>{position.uavType}</LedgerValue></td>
                    <td><StatusBadge value={position.readiness} reason={position.notReadyReason} /></td><td><LedgerValue>{position.bro}</LedgerValue></td><td><LedgerValue>{position.area}</LedgerValue></td><td><LedgerValue>{position.direction}</LedgerValue></td><td><LedgerValue>{position.note}</LedgerValue></td>
                    <td className="registry-actions-cell"><div className="registry-action-buttons">
                      <button type="button" className="registry-icon-button" title="Редагувати позицію" aria-label="Редагувати позицію" onClick={() => setEditor({ kind: "position", isNew: false, value: { ...position } })}><Pencil size={16} /></button>
                      <button type="button" className="registry-icon-button danger" title="Видалити позицію" aria-label="Видалити позицію" onClick={() => setPendingConfirmation({ title: "Видалити позицію?", label: `Позиція «${position.name || "Без назви"}» буде видалена. Екіпажі залишаться без позиції.`, action: () => setData((current) => ({ ...current, positions: current.positions.filter((item) => item.id !== position.id), assignments: current.assignments.filter((item) => item.positionId !== position.id) })) })}><Trash2 size={16} /></button>
                    </div></td>
                  </tr>)}
                </tbody>
              </table></div>
            </>}
            <div className="registry-table-status">
              <output className="registry-view-count" aria-live="polite">Показано {activeShownCount} з {activeTotalCount}</output>
            </div>
          </section>}

          {mainTab === "report" && <section className="registry-report-content">
            <StripsReportView report={report} zoom={tableZoom} />
          </section>}
        </div>
      </section>

      <footer className="export-bar strips-export-bar registry-export-bar">
        <div>
          <b>{validationErrors.length > 0 ? `Експорт недоступний: ${validationCountLabel(validationErrors.length)}` : "Готово до експорту"}</b>
          {validationErrors.length > 0 && <ol className="strips-validation-list">{validationErrors.map((problem, index) => <li key={`${index}-${problem}`}>{problem}</li>)}</ol>}
          {tauriAvailable && <span className={draftStatus === "error" ? "autosave-error" : "autosave-status"}>{draftStatus === "saving" ? "Зберігаю зміни…" : draftStatus === "error" ? "Не вдалося зберегти чернетку" : "Зміни збережено"}</span>}
        </div>
        <button type="button" className="primary-button" disabled={busy || validationErrors.length > 0} title={validationErrors.join("\n") || undefined} onClick={exportWorkbook}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />} Зберегти у XLSX
        </button>
      </footer>
    </main>
  );
}
