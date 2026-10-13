import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Link2, LoaderCircle, Minus, Plus, Trash2, Unlink2, X } from "lucide-react";
import CustomSelect, { type CustomSelectOption } from "./CustomSelect";
import { UAV_TYPES } from "./structure";
import {
  CREW_DUTIES,
  CREW_READINESS,
  POSITION_READINESS,
  calculateStripsSummary,
  readinessDisplay,
  upperUk,
  validateStripsReportErrors,
  type CrewDuty,
  type CrewReadiness,
  type PositionReadiness,
  type StripCrew,
  type StripPosition,
  type StripsReport,
  type UavType,
} from "./strips";
import {
  createEmptyStripsRegistry,
  createRegistryAssignment,
  createRegistryCrew,
  createRegistryPosition,
  effectiveCrewLocation,
  normalizeStripsRegistry,
  positionForCrew,
  registryToStripsReport,
  validateStripsRegistry,
  type RegistryAssignment,
  type RegistryCrew,
  type RegistryPosition,
  type StripsRegistryData,
} from "./stripsRegistry";

type RegistryTab = "crews" | "positions" | "overview";
type ReasonTarget = { kind: "crew" | "position"; id: string };

interface PendingReason {
  target: ReasonTarget;
  value: string;
}

interface PendingConfirmation {
  title: string;
  label: string;
  action: () => void;
}

const TABLE_ZOOM_STEPS = [60, 70, 80, 90, 100, 110, 125] as const;
const UAV_OPTIONS: ReadonlyArray<CustomSelectOption<UavType>> = UAV_TYPES.map((value) => ({ value, label: value }));
const DUTY_OPTIONS: ReadonlyArray<CustomSelectOption<CrewDuty>> = [
  ...CREW_DUTIES.map((value) => ({ value, label: value })),
  { value: "Формується", label: "Формується" },
];

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function messageFrom(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Не вдалося створити файл.";
}

function validationCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} помилок`;
  if (last === 1) return `${count} помилка`;
  if (last >= 2 && last <= 4) return `${count} помилки`;
  return `${count} помилок`;
}

function statusClass(status: string): string {
  if (status === "БГ") return "status-ready";
  if (status === "Не БГ") return "status-not-ready";
  if (status === "Формується") return "status-forming";
  return "status-neutral";
}

function Notification({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  return <div className={`message ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

function ReasonModal({
  value,
  onChange,
  onCancel,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.repeat) {
        event.preventDefault();
        if (value.trim()) onSave();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onSave, value]);

  return (
    <div className="reason-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="reason-modal" role="dialog" aria-modal="true" aria-labelledby="registry-reason-title" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="reason-modal-close" aria-label="Закрити" onClick={onCancel}><X size={18} /></button>
        <h2 id="registry-reason-title">Причина статусу «Не БГ»</h2>
        <p>Статус буде змінено тільки після збереження причини.</p>
        <textarea ref={inputRef} value={value} maxLength={500} rows={4} onChange={(event) => onChange(event.target.value)} placeholder="Наприклад: екіпаж виведено з позиції" />
        <div className="reason-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Скасувати</button>
          <button type="button" className="primary-button" disabled={!value.trim()} onClick={onSave}>Зберегти</button>
        </div>
      </section>
    </div>
  );
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
          <button type="button" className="secondary-button danger-button" onClick={onConfirm}>Видалити</button>
        </div>
      </section>
    </div>
  );
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

function ReadonlyValue({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span className={`registry-readonly-value${muted ? " muted" : ""}`}>{children || "—"}</span>;
}

interface PreviewRow {
  key: string;
  crew: StripCrew | null;
  position: StripPosition | null;
}

function PreviewTable({ report }: { report: StripsReport }) {
  return (
    <div className="registry-preview-sections">
      {report.strips.length === 0 && <p className="registry-empty">Після додавання екіпажів або позицій тут автоматично з’явиться сформована таблиця.</p>}
      {report.strips.map((strip) => (
        <section className="registry-preview-strip" key={strip.id}>
          <h3>{strip.name || "Смуга без назви"}</h3>
          <table className="registry-preview-table">
            <thead>
              <tr>
                <th>Підрозділ</th><th>Тип БпЛА</th><th>Назва екіпажу</th><th>БГ екіпажу</th>
                <th>БЧ екіпажу</th><th>Засіб</th><th>Позиція</th><th>БГ позиції</th>
                <th>БРО</th><th>Район</th><th>Напрямок роботи</th><th>Примітки</th>
              </tr>
            </thead>
            <tbody>
              {strip.groups.flatMap((group) => {
                const linked = group.positions.flatMap<PreviewRow>((position) => {
                  if (position.crews.length === 0) {
                    return [{ key: position.id, crew: null, position }];
                  }
                  return position.crews.map((crew) => ({ key: `${position.id}-${crew.id}`, crew, position }));
                });
                const loose: PreviewRow[] = group.looseCrews.map((crew) => ({ key: crew.id, crew, position: null }));
                return [...linked, ...loose].map(({ key, crew, position }) => {
                  const tone = crew && position
                    ? statusClass(crew.readiness || position.readiness)
                    : "status-neutral";
                  return (
                    <tr key={key} className={tone}>
                      <td>{group.unit || "—"}</td>
                      <td>{group.uavType || "—"}</td>
                      <td>{crew?.name || "Позиція без екіпажу"}</td>
                      <td>{crew ? readinessDisplay(crew.readiness, crew.notReadyReason) : "—"}</td>
                      <td>{crew?.duty || "—"}</td>
                      <td>{crew?.assets || "—"}</td>
                      <td>{position?.name || "Екіпаж без позиції"}</td>
                      <td>{position ? readinessDisplay(position.readiness, position.notReadyReason) : "—"}</td>
                      <td>{position?.bro || "—"}</td>
                      <td>{position?.area || "—"}</td>
                      <td>{position?.direction || "—"}</td>
                      <td>{position?.note || crew?.note || "—"}</td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export default function StripsRegistryWorkspace() {
  const [data, setData] = useState<StripsRegistryData>(() => createEmptyStripsRegistry(tomorrow()));
  const [activeTab, setActiveTab] = useState<RegistryTab>("crews");
  const [pendingReason, setPendingReason] = useState<PendingReason | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [tableZoom, setTableZoom] = useState(80);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [donePath, setDonePath] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saved" | "saving" | "error">("saved");
  const contentRef = useRef<HTMLDivElement>(null);
  const tauriAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const report = useMemo(() => registryToStripsReport(data), [data]);
  const summary = useMemo(() => calculateStripsSummary(report.strips), [report.strips]);
  const validationErrors = useMemo(() => {
    const registryProblems = validateStripsRegistry(data);
    return registryProblems.length > 0 ? registryProblems : validateStripsReportErrors(report);
  }, [data, report]);

  useEffect(() => {
    if (!tauriAvailable) {
      setDraftReady(true);
      return;
    }
    let disposed = false;
    void invoke<string | null>("load_workspace_draft", { variant: "strips-registry" })
      .then((payload) => {
        if (disposed || !payload) return;
        const restored = normalizeStripsRegistry(JSON.parse(payload));
        if (restored) setData(restored);
      })
      .catch(() => setDraftStatus("error"))
      .finally(() => {
        if (!disposed) setDraftReady(true);
      });
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
  }, [activeTab]);

  function updateCrew(crewId: string, update: (crew: RegistryCrew) => RegistryCrew) {
    setData((current) => ({
      ...current,
      crews: current.crews.map((crew) => crew.id === crewId ? update(crew) : crew),
    }));
  }

  function updatePosition(positionId: string, update: (position: RegistryPosition) => RegistryPosition) {
    setData((current) => {
      const original = current.positions.find((position) => position.id === positionId);
      if (!original) return current;
      const changed = update(original);
      const linkedCrewIds = new Set(
        current.assignments
          .filter((assignment) => assignment.positionId === positionId)
          .map((assignment) => assignment.crewId),
      );
      return {
        ...current,
        positions: current.positions.map((position) => position.id === positionId ? changed : position),
        crews: current.crews.map((crew) => linkedCrewIds.has(crew.id) ? {
          ...crew,
          strip: changed.strip,
          unit: changed.unit,
          uavType: changed.uavType,
        } : crew),
      };
    });
  }

  function updateAssignment(assignmentId: string, update: (assignment: RegistryAssignment) => RegistryAssignment) {
    setData((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) => assignment.id === assignmentId ? update(assignment) : assignment),
    }));
  }

  function detachCrewIfNeeded(crew: RegistryCrew, readiness: CrewReadiness) {
    const position = positionForCrew(data, crew.id);
    const mustDetach = readiness === "Формується" || Boolean(position?.readiness && position.readiness !== readiness);
    if (!mustDetach) return false;
    setData((current) => ({
      ...current,
      assignments: current.assignments.filter((assignment) => assignment.crewId !== crew.id),
    }));
    return true;
  }

  function requestCrewReadiness(crew: RegistryCrew, readiness: CrewReadiness) {
    if (readiness === "Не БГ") {
      setPendingReason({ target: { kind: "crew", id: crew.id }, value: crew.readiness === "Не БГ" ? crew.notReadyReason : "" });
      return;
    }
    const detached = detachCrewIfNeeded(crew, readiness);
    updateCrew(crew.id, (current) => ({
      ...current,
      readiness,
      notReadyReason: "",
      duty: readiness === "Формується" ? "Формується" : current.duty === "Формується" ? "" : current.duty,
    }));
    if (detached) setNotice(`Екіпаж «${crew.name || "Без назви"}» відкріплено від несумісної позиції.`);
  }

  function requestPositionReadiness(position: RegistryPosition, readiness: PositionReadiness) {
    if (readiness === "Не БГ") {
      setPendingReason({ target: { kind: "position", id: position.id }, value: position.readiness === "Не БГ" ? position.notReadyReason : "" });
      return;
    }
    const detachedIds = new Set(
      data.assignments
        .filter((assignment) => assignment.positionId === position.id)
        .filter((assignment) => data.crews.find((crew) => crew.id === assignment.crewId)?.readiness !== readiness)
        .map((assignment) => assignment.id),
    );
    setData((current) => ({
      ...current,
      positions: current.positions.map((candidate) => candidate.id === position.id
        ? { ...candidate, readiness, notReadyReason: "" }
        : candidate),
      assignments: current.assignments.filter((assignment) => !detachedIds.has(assignment.id)),
    }));
    if (detachedIds.size > 0) setNotice(`Від позиції «${position.name || "Без назви"}» відкріплено несумісні екіпажі.`);
  }

  function saveNotReadyReason() {
    if (!pendingReason?.value.trim()) return;
    const { target, value } = pendingReason;
    if (target.kind === "crew") {
      const crew = data.crews.find((item) => item.id === target.id);
      if (crew) {
        const detached = detachCrewIfNeeded(crew, "Не БГ");
        updateCrew(crew.id, (current) => ({
          ...current,
          readiness: "Не БГ",
          notReadyReason: value.trim(),
          duty: current.duty === "Формується" ? "" : current.duty,
        }));
        if (detached) setNotice(`Екіпаж «${crew.name || "Без назви"}» відкріплено від несумісної позиції.`);
      }
    } else {
      const position = data.positions.find((item) => item.id === target.id);
      if (position) {
        const detachedIds = new Set(
          data.assignments
            .filter((assignment) => assignment.positionId === position.id)
            .filter((assignment) => data.crews.find((crew) => crew.id === assignment.crewId)?.readiness !== "Не БГ")
            .map((assignment) => assignment.id),
        );
        setData((current) => ({
          ...current,
          positions: current.positions.map((candidate) => candidate.id === position.id
            ? { ...candidate, readiness: "Не БГ", notReadyReason: value.trim() }
            : candidate),
          assignments: current.assignments.filter((assignment) => !detachedIds.has(assignment.id)),
        }));
        if (detachedIds.size > 0) setNotice(`Від позиції «${position.name || "Без назви"}» відкріплено несумісні екіпажі.`);
      }
    }
    setPendingReason(null);
  }

  function chooseAssignmentCrew(assignment: RegistryAssignment, crewId: string) {
    const crew = data.crews.find((item) => item.id === crewId);
    const currentPosition = data.positions.find((item) => item.id === assignment.positionId);
    const compatible = Boolean(crew && currentPosition
      && crew.readiness !== "Формується"
      && (!crew.readiness || !currentPosition.readiness || crew.readiness === currentPosition.readiness));
    updateAssignment(assignment.id, (current) => ({
      ...current,
      crewId,
      positionId: compatible ? current.positionId : "",
    }));
  }

  function chooseAssignmentPosition(assignment: RegistryAssignment, positionId: string) {
    const crew = data.crews.find((item) => item.id === assignment.crewId);
    const position = data.positions.find((item) => item.id === positionId);
    if (!crew || !position) return;
    if (crew.readiness === "Формується") {
      setError("Екіпаж зі статусом «Формується» не може мати позицію.");
      return;
    }
    if (crew.readiness && position.readiness && crew.readiness !== position.readiness) {
      setError("Позицію не призначено: статус екіпажу має збігатися зі статусом позиції.");
      return;
    }
    setData((current) => ({
      ...current,
      assignments: current.assignments.map((item) => item.id === assignment.id ? { ...item, positionId } : item),
      crews: current.crews.map((item) => item.id === crew.id ? {
        ...item,
        strip: position.strip,
        unit: position.unit,
        uavType: position.uavType,
      } : item),
    }));
  }

  function changeZoom(direction: -1 | 1) {
    const current = TABLE_ZOOM_STEPS.findIndex((value) => value === tableZoom);
    const next = Math.max(0, Math.min(TABLE_ZOOM_STEPS.length - 1, current + direction));
    setTableZoom(TABLE_ZOOM_STEPS[next]);
  }

  function confirmDelete(value: PendingConfirmation) {
    setPendingConfirmation(value);
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
      const saved = await invoke<string>("export_strips_workbook", { request: { ...report, outputPath } });
      setDonePath(saved);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  const assignedCrewIds = new Set(data.assignments.map((assignment) => assignment.crewId).filter(Boolean));

  return (
    <main className="app-shell strips-shell registry-shell">
      {error && <Notification kind="error">{error}</Notification>}
      {notice && <Notification kind="success">{notice}</Notification>}
      {donePath && <Notification kind="success">Файл збережено: {donePath}</Notification>}
      {pendingReason && (
        <ReasonModal
          value={pendingReason.value}
          onChange={(value) => setPendingReason((current) => current ? { ...current, value } : current)}
          onCancel={() => setPendingReason(null)}
          onSave={saveNotReadyReason}
        />
      )}
      {pendingConfirmation && (
        <ConfirmationModal value={pendingConfirmation} onCancel={() => setPendingConfirmation(null)} onConfirm={runConfirmation} />
      )}

      <section className="workspace-panel registry-panel">
        <div className="registry-toolbar">
          <nav className="registry-tabs" aria-label="Розділи реєстру">
            <button type="button" className={activeTab === "crews" ? "active" : ""} onClick={() => setActiveTab("crews")}>Екіпажі <span>{data.crews.length}</span></button>
            <button type="button" className={activeTab === "positions" ? "active" : ""} onClick={() => setActiveTab("positions")}>Позиції <span>{data.positions.length}</span></button>
            <button type="button" className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Загальна таблиця</button>
          </nav>
          <div className="registry-toolbar-controls">
            <label>Дата звіту<input type="date" value={data.reportDate} onChange={(event) => setData((current) => ({ ...current, reportDate: event.target.value }))} /></label>
            <div className="bcs-zoom-control" aria-label="Масштаб таблиці">
              <span>Масштаб</span>
              <button type="button" aria-label="Зменшити масштаб" disabled={tableZoom === TABLE_ZOOM_STEPS[0]} onClick={() => changeZoom(-1)}><Minus size={15} /></button>
              <output>{tableZoom}%</output>
              <button type="button" aria-label="Збільшити масштаб" disabled={tableZoom === TABLE_ZOOM_STEPS[TABLE_ZOOM_STEPS.length - 1]} onClick={() => changeZoom(1)}><Plus size={15} /></button>
            </div>
          </div>
        </div>

        <div ref={contentRef} className="registry-content-scroll">
          <div className="registry-table-scale" style={{ "--registry-zoom": tableZoom / 100 } as CSSProperties}>
            {activeTab === "crews" && (
              <section className="registry-tab-content">
                <div className="registry-section-heading">
                  <div><h1>Реєстр екіпажів</h1><p>Один екіпаж — один запис. Дані позиції підтягуються автоматично зі зв’язку.</p></div>
                  <button type="button" className="secondary-button" onClick={() => setData((current) => ({ ...current, crews: [...current.crews, createRegistryCrew()] }))}><Plus size={16} /> Додати екіпаж</button>
                </div>
                <table className="registry-data-table registry-crews-table">
                  <thead><tr>
                    <th>Назва екіпажу</th><th>Позиція</th><th>Смуга</th><th>БРО</th><th>Напрямок</th><th>Район</th>
                    <th>Підрозділ</th><th>Тип БпЛА</th><th>БГ</th><th>БЧ</th><th>Засіб</th><th>Примітки</th><th></th>
                  </tr></thead>
                  <tbody>
                    {data.crews.length === 0 && <tr><td colSpan={13} className="registry-empty-cell">Додайте перший екіпаж.</td></tr>}
                    {data.crews.map((crew) => {
                      const location = effectiveCrewLocation(data, crew);
                      const linked = Boolean(location.position);
                      return (
                        <tr key={crew.id} className={statusClass(crew.readiness)}>
                          <td><input value={crew.name} maxLength={250} onChange={(event) => updateCrew(crew.id, (current) => ({ ...current, name: event.target.value }))} /></td>
                          <td><ReadonlyValue muted={!linked}>{location.position?.name || "Без позиції"}</ReadonlyValue></td>
                          <td>{linked ? <ReadonlyValue>{location.strip}</ReadonlyValue> : <input value={crew.strip} maxLength={200} onChange={(event) => updateCrew(crew.id, (current) => ({ ...current, strip: event.target.value }))} />}</td>
                          <td><ReadonlyValue muted={!linked}>{location.bro}</ReadonlyValue></td>
                          <td><ReadonlyValue muted={!linked}>{location.direction}</ReadonlyValue></td>
                          <td><ReadonlyValue muted={!linked}>{location.area}</ReadonlyValue></td>
                          <td>{linked ? <ReadonlyValue>{location.unit}</ReadonlyValue> : <input value={crew.unit} maxLength={250} onChange={(event) => updateCrew(crew.id, (current) => ({ ...current, unit: event.target.value }))} />}</td>
                          <td>{linked ? <ReadonlyValue>{location.uavType}</ReadonlyValue> : <CustomSelect<UavType> ariaLabel={`${crew.name || "Екіпаж"}: тип БпЛА`} value={crew.uavType} options={UAV_OPTIONS} onChange={(value) => updateCrew(crew.id, (current) => ({ ...current, uavType: value }))} />}</td>
                          <td><CustomSelect<CrewReadiness> ariaLabel={`${crew.name || "Екіпаж"}: БГ`} value={crew.readiness} options={crewReadinessOptions(crew)} onChange={(value) => requestCrewReadiness(crew, value)} /></td>
                          <td><CustomSelect<CrewDuty> ariaLabel={`${crew.name || "Екіпаж"}: БЧ`} value={crew.duty} options={DUTY_OPTIONS} disabled={crew.readiness === "Формується"} onChange={(value) => updateCrew(crew.id, (current) => ({ ...current, duty: value }))} /></td>
                          <td><textarea value={crew.assets} maxLength={500} rows={2} onBlur={(event) => updateCrew(crew.id, (current) => ({ ...current, assets: event.target.value.split(",").map((item) => item.trim()).filter(Boolean).join(", ") }))} onChange={(event) => updateCrew(crew.id, (current) => ({ ...current, assets: event.target.value }))} /></td>
                          <td><textarea value={crew.note} maxLength={1000} rows={2} onChange={(event) => updateCrew(crew.id, (current) => ({ ...current, note: event.target.value }))} /></td>
                          <td className="registry-actions-cell"><button type="button" className="registry-icon-button danger" aria-label="Видалити екіпаж" onClick={() => confirmDelete({ title: "Видалити екіпаж?", label: `Екіпаж «${crew.name || "Без назви"}» і його зв’язок із позицією буде видалено.`, action: () => setData((current) => ({ ...current, crews: current.crews.filter((item) => item.id !== crew.id), assignments: current.assignments.filter((item) => item.crewId !== crew.id) })) })}><Trash2 size={16} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}

            {activeTab === "positions" && (
              <section className="registry-tab-content">
                <div className="registry-section-heading">
                  <div><h1>Реєстр позицій</h1><p>Поля позиції є спільними для всіх прикріплених до неї екіпажів.</p></div>
                  <button type="button" className="secondary-button" onClick={() => setData((current) => ({ ...current, positions: [...current.positions, createRegistryPosition()] }))}><Plus size={16} /> Додати позицію</button>
                </div>
                <table className="registry-data-table registry-positions-table">
                  <thead><tr>
                    <th>Назва позиції</th><th>Смуга</th><th>Підрозділ</th><th>Тип БпЛА</th><th>БГ позиції</th>
                    <th>БРО</th><th>Район</th><th>Напрямок роботи</th><th>Екіпажі</th><th>Примітки</th><th></th>
                  </tr></thead>
                  <tbody>
                    {data.positions.length === 0 && <tr><td colSpan={11} className="registry-empty-cell">Додайте першу позицію.</td></tr>}
                    {data.positions.map((position) => {
                      const linkedCrews = data.assignments
                        .filter((assignment) => assignment.positionId === position.id)
                        .map((assignment) => data.crews.find((crew) => crew.id === assignment.crewId)?.name)
                        .filter(Boolean) as string[];
                      return (
                        <tr key={position.id} className={statusClass(position.readiness)}>
                          <td><input value={position.name} maxLength={250} onChange={(event) => updatePosition(position.id, (current) => ({ ...current, name: event.target.value }))} /></td>
                          <td><input value={position.strip} maxLength={200} onChange={(event) => updatePosition(position.id, (current) => ({ ...current, strip: event.target.value }))} /></td>
                          <td><input value={position.unit} maxLength={250} onChange={(event) => updatePosition(position.id, (current) => ({ ...current, unit: event.target.value }))} /></td>
                          <td><CustomSelect<UavType> ariaLabel={`${position.name || "Позиція"}: тип БпЛА`} value={position.uavType} options={UAV_OPTIONS} onChange={(value) => updatePosition(position.id, (current) => ({ ...current, uavType: value }))} /></td>
                          <td><CustomSelect<PositionReadiness> ariaLabel={`${position.name || "Позиція"}: БГ`} value={position.readiness} options={positionReadinessOptions(position)} onChange={(value) => requestPositionReadiness(position, value)} /></td>
                          <td><input value={position.bro} maxLength={250} onChange={(event) => updatePosition(position.id, (current) => ({ ...current, bro: event.target.value }))} /></td>
                          <td><input value={position.area} maxLength={250} onChange={(event) => updatePosition(position.id, (current) => ({ ...current, area: upperUk(event.target.value) }))} /></td>
                          <td><textarea value={position.direction} maxLength={500} rows={2} onChange={(event) => updatePosition(position.id, (current) => ({ ...current, direction: event.target.value }))} /></td>
                          <td><ReadonlyValue muted={linkedCrews.length === 0}>{linkedCrews.join(", ") || "Без екіпажу"}</ReadonlyValue></td>
                          <td><textarea value={position.note} maxLength={1000} rows={2} onChange={(event) => updatePosition(position.id, (current) => ({ ...current, note: event.target.value }))} /></td>
                          <td className="registry-actions-cell"><button type="button" className="registry-icon-button danger" aria-label="Видалити позицію" onClick={() => confirmDelete({ title: "Видалити позицію?", label: `Позиція «${position.name || "Без назви"}» буде видалена. Екіпажі залишаться у реєстрі без позиції.`, action: () => setData((current) => ({ ...current, positions: current.positions.filter((item) => item.id !== position.id), assignments: current.assignments.filter((item) => item.positionId !== position.id) })) })}><Trash2 size={16} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}

            {activeTab === "overview" && (
              <section className="registry-tab-content registry-overview-content">
                <div className="registry-section-heading">
                  <div><h1>Розподіл екіпажів по позиціях</h1><p>Оберіть існуючий екіпаж і позицію. Один екіпаж можна використати лише один раз; одна позиція може мати кілька екіпажів.</p></div>
                  <button type="button" className="secondary-button" disabled={assignedCrewIds.size >= data.crews.length || data.positions.length === 0} onClick={() => setData((current) => ({ ...current, assignments: [...current.assignments, createRegistryAssignment()] }))}><Link2 size={16} /> Додати зв’язок</button>
                </div>
                <table className="registry-data-table registry-assignment-table">
                  <thead><tr><th>Екіпаж</th><th>Позиція</th><th>Смуга</th><th>Підрозділ</th><th>Тип БпЛА</th><th>Статус</th><th></th></tr></thead>
                  <tbody>
                    {data.assignments.length === 0 && <tr><td colSpan={7} className="registry-empty-cell">Зв’язків ще немає. Екіпажі без зв’язку автоматично потраплять у таблицю як «Екіпаж без позиції».</td></tr>}
                    {data.assignments.map((assignment) => {
                      const crew = data.crews.find((item) => item.id === assignment.crewId);
                      const position = data.positions.find((item) => item.id === assignment.positionId);
                      const crewOptions: ReadonlyArray<CustomSelectOption<string>> = data.crews.map((item) => ({
                        value: item.id,
                        label: `${item.name || "Без назви"} — ${item.unit || "підрозділ не вказано"}`,
                        disabled: item.id !== assignment.crewId && assignedCrewIds.has(item.id),
                      }));
                      const positionOptions: ReadonlyArray<CustomSelectOption<string>> = data.positions.map((item) => ({
                        value: item.id,
                        label: `${item.name || "Без назви"} — ${item.strip || "смуга не вказана"} — ${item.unit || "підрозділ не вказано"}`,
                        disabled: Boolean(crew && (
                          crew.readiness === "Формується"
                          || (crew.readiness && item.readiness && crew.readiness !== item.readiness)
                        )),
                      }));
                      return (
                        <tr key={assignment.id} className={statusClass(crew?.readiness || position?.readiness || "")}>
                          <td><CustomSelect<string> ariaLabel="Оберіть екіпаж" value={assignment.crewId} options={crewOptions} onChange={(value) => chooseAssignmentCrew(assignment, value)} /></td>
                          <td><CustomSelect<string> ariaLabel="Оберіть позицію" value={assignment.positionId} options={positionOptions} disabled={!crew} onChange={(value) => chooseAssignmentPosition(assignment, value)} /></td>
                          <td><ReadonlyValue>{position?.strip}</ReadonlyValue></td>
                          <td><ReadonlyValue>{position?.unit}</ReadonlyValue></td>
                          <td><ReadonlyValue>{position?.uavType}</ReadonlyValue></td>
                          <td><ReadonlyValue>{crew && position ? `${readinessDisplay(crew.readiness, crew.notReadyReason)} / ${readinessDisplay(position.readiness, position.notReadyReason)}` : "Не завершено"}</ReadonlyValue></td>
                          <td className="registry-actions-cell"><button type="button" className="registry-icon-button danger" aria-label="Прибрати зв’язок" onClick={() => setData((current) => ({ ...current, assignments: current.assignments.filter((item) => item.id !== assignment.id) }))}><Unlink2 size={16} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="registry-generated-heading">
                  <div><h2>Сформована таблиця</h2><p>Цю частину не можна редагувати. Вона змінюється лише через реєстри та розподіл вище.</p></div>
                  <div className="registry-summary-chips">
                    <span>Екіпажів: <b>{summary.crewTotals.total}</b></span>
                    <span>БГ: <b>{summary.crewTotals.ready}</b></span>
                    <span>Не БГ: <b>{summary.crewTotals.notReady}</b></span>
                    <span>Позицій: <b>{summary.positionTotals.total}</b></span>
                    <span>Без позиції: <b>{summary.crewsWithoutPosition}</b></span>
                    <span>Без екіпажу: <b>{summary.positionsWithoutCrews}</b></span>
                  </div>
                </div>
                <PreviewTable report={report} />
              </section>
            )}
          </div>
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
