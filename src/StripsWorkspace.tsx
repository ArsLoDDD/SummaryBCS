import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Link2,
  LoaderCircle,
  MapPinPlus,
  Minus,
  Plus,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import CustomSelect, { type CustomSelectOption } from "./CustomSelect";
import { UAV_TYPES } from "./structure";
import {
  CREW_DUTIES,
  CREW_READINESS,
  POSITION_READINESS,
  attachLooseCrew,
  attachmentProblem,
  calculateStripsSummary,
  createCrew,
  createCrewForPosition,
  createGroup,
  createPosition,
  createPositionForLooseCrew,
  createStrip,
  detachCrew,
  normalizeStripsReport,
  readinessDisplay,
  setCrewReadinessInGroup,
  setPositionReadinessInGroup,
  upperUk,
  validateStripsReportErrors,
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

const TABLE_ZOOM_STEPS = [50, 60, 70, 80, 90, 100, 110, 125] as const;

function tomorrow(): string {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
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

function cleanAssets(value: string): string {
  return value.split(",").map((item) => item.trim()).filter(Boolean).join(", ");
}

function validationCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} помилок`;
  if (last === 1) return `${count} помилка`;
  if (last >= 2 && last <= 4) return `${count} помилки`;
  return `${count} помилок`;
}

function Notification({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  return <div className={`message ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

type ReasonTarget =
  | { kind: "position"; stripId: string; groupId: string; positionId: string }
  | { kind: "crew"; stripId: string; groupId: string; positionId: string | null; crewId: string };

interface PendingReason {
  target: ReasonTarget;
  value: string;
}

interface PendingConfirmation {
  title: string;
  label: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => void;
}

interface PendingLink {
  stripId: string;
  groupId: string;
  positionId: string;
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
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.repeat) {
        event.preventDefault();
        if (value.trim()) onSave();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onSave, value]);

  return (
    <div className="reason-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="reason-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reason-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="reason-modal-close" aria-label="Закрити" onClick={onCancel}>
          <X size={18} />
        </button>
        <h2 id="reason-modal-title">Причина статусу «Не БГ»</h2>
        <p>Статус встановиться тільки після збереження причини.</p>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Наприклад: екіпаж виведено з позиції"
          maxLength={500}
          rows={4}
        />
        <div className="reason-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Скасувати</button>
          <button type="button" className="primary-button" onClick={onSave} disabled={!value.trim()}>
            Зберегти
          </button>
        </div>
      </section>
    </div>
  );
}

function ConfirmationModal({
  title,
  label,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  label: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Enter" && !event.isComposing && !event.repeat) {
        event.preventDefault();
        onConfirm();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onConfirm]);

  return (
    <div className="reason-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="reason-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="reason-modal-close" aria-label="Закрити" onClick={onCancel}>
          <X size={18} />
        </button>
        <h2 id="confirmation-modal-title">{title}</h2>
        <p>{label} Після підтвердження ця дія одразу збережеться в чернетці.</p>
        <div className="reason-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Скасувати</button>
          <button type="button" className={danger ? "secondary-button danger-button" : "primary-button"} onClick={onConfirm} autoFocus>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function LinkCrewModal({
  position,
  crews,
  onCancel,
  onSelect,
}: {
  position: StripPosition;
  crews: StripCrew[];
  onCancel: () => void;
  onSelect: (crewId: string) => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="reason-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="reason-modal strips-link-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-crew-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="reason-modal-close" aria-label="Закрити" onClick={onCancel}>
          <X size={18} />
        </button>
        <h2 id="link-crew-modal-title">Приєднати екіпаж до позиції</h2>
        <p>Оберіть екіпаж без позиції. Запис буде перенесено, а не скопійовано.</p>
        <div className="strips-link-list">
          {crews.length === 0 && <span>У цьому блоці немає екіпажів без позиції.</span>}
          {crews.map((crew) => {
            const problem = attachmentProblem(position, crew);
            return (
              <button
                type="button"
                key={crew.id}
                disabled={Boolean(problem)}
                title={problem || undefined}
                onClick={() => onSelect(crew.id)}
              >
                <b>{crew.name || "Екіпаж без назви"}</b>
                <span>{readinessDisplay(crew.readiness || "Статус не вказано", crew.notReadyReason)}</span>
                {problem && <small>{problem}</small>}
              </button>
            );
          })}
        </div>
        <div className="reason-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Закрити</button>
        </div>
      </section>
    </div>
  );
}

function statusClass(status: string): string {
  if (status === "БГ") return "status-ready";
  if (status === "Не БГ") return "status-not-ready";
  if (status === "Формується") return "status-forming";
  return "";
}

function StripsColGroup() {
  return (
    <colgroup>
      <col className="strips-col-unit" />
      <col className="strips-col-type" />
      <col className="strips-col-crew" />
      <col className="strips-col-crew-ready" />
      <col className="strips-col-duty" />
      <col className="strips-col-assets" />
      <col className="strips-col-position" />
      <col className="strips-col-position-ready" />
      <col className="strips-col-bro" />
      <col className="strips-col-area" />
      <col className="strips-col-direction" />
      <col className="strips-col-note" />
    </colgroup>
  );
}

const HEADERS = [
  "Підрозділ",
  "Тип БпЛА",
  "Назва екіпажу",
  "БГ екіпажу",
  "БЧ екіпажу",
  "Засіб",
  "Позиція",
  "БГ позиції",
  "БРО",
  "Район",
  "Напрямок роботи",
  "Примітки",
] as const;

interface CrewCellsProps {
  crew: StripCrew;
  label: string;
  onUpdate: <K extends keyof StripCrew>(field: K, value: StripCrew[K]) => void;
  onReadiness: (value: CrewReadiness) => void;
  onDetach?: () => void;
  onRemove: () => void;
  neutral?: boolean;
}

function CrewCells({ crew, label, onUpdate, onReadiness, onDetach, onRemove, neutral = false }: CrewCellsProps) {
  const readinessOptions: ReadonlyArray<CustomSelectOption<CrewReadiness>> = CREW_READINESS.map((value) => ({
    value,
    label: value === "Не БГ" ? readinessDisplay(value, crew.notReadyReason) : value,
  }));
  const dutyOptions: ReadonlyArray<CustomSelectOption<CrewDuty>> = crew.readiness === "Формується"
    ? [{ value: "Формується", label: "Формується" }]
    : CREW_DUTIES.map((value) => ({ value, label: value }));
  const tone = neutral ? "status-neutral" : statusClass(crew.readiness);

  return (
    <>
      <td className={`strips-status-band ${tone}${!crew.name.trim() ? " strips-warning-cell" : ""}`}>
        <div className="strips-input-actions">
          <input
            aria-label={`${label}: назва екіпажу`}
            value={crew.name}
            maxLength={250}
            onChange={(event) => onUpdate("name", event.target.value)}
          />
          <div className="strips-crew-actions">
            {onDetach && (
              <button type="button" title="Відкріпити екіпаж від позиції" aria-label={`${label}: відкріпити від позиції`} onClick={onDetach}>
                <Unlink2 size={14} />
              </button>
            )}
            <button type="button" className="danger" title="Видалити екіпаж" aria-label={`${label}: видалити екіпаж`} onClick={onRemove}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </td>
      <td className={`strips-status-band strips-status-cell ${tone}${!crew.readiness ? " strips-warning-cell" : ""}`}>
        <CustomSelect
          ariaLabel={`${label}: БГ екіпажу`}
          value={crew.readiness}
          options={readinessOptions}
          onChange={onReadiness}
        />
      </td>
      <td className={`strips-status-band ${tone}${!crew.duty ? " strips-warning-cell" : ""}`}>
        <CustomSelect
          ariaLabel={`${label}: БЧ екіпажу`}
          value={crew.duty}
          options={dutyOptions}
          onChange={(value) => onUpdate("duty", value)}
          disabled={crew.readiness === "Формується"}
        />
      </td>
      <td className={`strips-status-band ${tone}`}>
        <input
          aria-label={`${label}: засіб`}
          value={crew.assets}
          maxLength={1000}
          onChange={(event) => onUpdate("assets", event.target.value)}
          onBlur={() => onUpdate("assets", cleanAssets(crew.assets))}
        />
      </td>
    </>
  );
}

type GroupTableRow =
  | {
      kind: "position";
      position: StripPosition;
      positionIndex: number;
      crew: StripCrew | null;
      crewIndex: number;
      positionRowCount: number;
    }
  | { kind: "loose"; crew: StripCrew; crewIndex: number }
  | { kind: "empty" };

function groupTableRows(group: StripGroup): GroupTableRow[] {
  const rows: GroupTableRow[] = [];
  group.positions.forEach((position, positionIndex) => {
    const crews: Array<StripCrew | null> = position.crews.length > 0 ? position.crews : [null];
    crews.forEach((crew, crewIndex) => rows.push({
      kind: "position",
      position,
      positionIndex,
      crew,
      crewIndex,
      positionRowCount: crews.length,
    }));
  });
  group.looseCrews.forEach((crew, crewIndex) => rows.push({ kind: "loose", crew, crewIndex }));
  return rows.length > 0 ? rows : [{ kind: "empty" }];
}

function SummaryTables({ summary }: { summary: ReturnType<typeof calculateStripsSummary> }) {
  return (
    <section className="strips-summary" aria-label="Загальний підсумок">
      <h2>Загальний підсумок</h2>
      <div className="strips-summary-grid">
        <table>
          <caption>Екіпажі за типом БпЛА</caption>
          <thead><tr><th>Тип БпЛА</th><th>БГ</th><th>Не БГ</th><th>Формується</th><th>Всього</th></tr></thead>
          <tbody>
            {summary.crews.map((row) => (
              <tr key={row.uavType}><th>{row.uavType}</th><td>{row.ready}</td><td>{row.notReady}</td><td>{row.forming}</td><td>{row.total}</td></tr>
            ))}
            <tr className="strips-total-row"><th>Усього</th><td>{summary.crewTotals.ready}</td><td>{summary.crewTotals.notReady}</td><td>{summary.crewTotals.forming}</td><td>{summary.crewTotals.total}</td></tr>
          </tbody>
        </table>

        <table>
          <caption>Позиції за типом БпЛА</caption>
          <thead><tr><th>Тип БпЛА</th><th>БГ</th><th>Не БГ</th><th>Всього</th></tr></thead>
          <tbody>
            {summary.positions.map((row) => (
              <tr key={row.uavType}><th>{row.uavType}</th><td>{row.ready}</td><td>{row.notReady}</td><td>{row.total}</td></tr>
            ))}
            <tr className="strips-total-row"><th>Усього</th><td>{summary.positionTotals.ready}</td><td>{summary.positionTotals.notReady}</td><td>{summary.positionTotals.total}</td></tr>
          </tbody>
        </table>

        <table>
          <caption>Довідково: записи без зв’язку</caption>
          <thead><tr><th>Тип БпЛА</th><th>Екіпажів без позиції</th><th>Позицій без екіпажів</th></tr></thead>
          <tbody>
            {summary.exceptions.map((row) => (
              <tr key={row.uavType}><th>{row.uavType}</th><td>{row.crewsWithoutPosition}</td><td>{row.positionsWithoutCrews}</td></tr>
            ))}
            <tr className="strips-total-row"><th>Усього</th><td>{summary.crewsWithoutPosition}</td><td>{summary.positionsWithoutCrews}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StripSummaryRow({ strip }: { strip: WorkStrip }) {
  const summary = calculateStripsSummary([strip]);
  return (
    <table className="strips-strip-summary" aria-label={`Підсумок смуги ${strip.name || "без назви"}`}>
      <thead>
        <tr><th>Показник</th><th>Всього</th><th className="status-ready">БГ</th><th className="status-not-ready">Не БГ</th></tr>
      </thead>
      <tbody>
        <tr>
          <th>Екіпажі</th>
          <td>{summary.crewTotals.total}</td>
          <td className="status-ready">{summary.crewTotals.ready}</td>
          <td className="status-not-ready">{summary.crewTotals.notReady}</td>
        </tr>
        <tr>
          <th>Позиції</th>
          <td>{summary.positionTotals.total}</td>
          <td className="status-ready">{summary.positionTotals.ready}</td>
          <td className="status-not-ready">{summary.positionTotals.notReady}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function StripsWorkspace() {
  const [report, setReport] = useState<StripsReport>(() => ({
    version: 1,
    reportDate: tomorrow(),
    strips: [createStrip()],
  }));
  const [pendingReason, setPendingReason] = useState<PendingReason | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [tableZoom, setTableZoom] = useState(80);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [donePath, setDonePath] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saved" | "saving" | "error">("saved");
  const tauriAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const validationErrors = useMemo(() => validateStripsReportErrors(report), [report]);
  const summary = useMemo(() => calculateStripsSummary(report.strips), [report.strips]);
  const uavOptions = UAV_TYPES.map((value) => ({ value, label: value }));
  const pendingLinkContext = useMemo(() => {
    if (!pendingLink) return null;
    const strip = report.strips.find((item) => item.id === pendingLink.stripId);
    const group = strip?.groups.find((item) => item.id === pendingLink.groupId);
    const position = group?.positions.find((item) => item.id === pendingLink.positionId);
    return group && position ? { group, position } : null;
  }, [pendingLink, report.strips]);

  useEffect(() => {
    if (!tauriAvailable) {
      setDraftReady(true);
      return;
    }
    let disposed = false;
    void invoke<string | null>("load_workspace_draft", { variant: "strips" })
      .then((payload) => {
        if (disposed || !payload) return;
        const restored = normalizeStripsReport(JSON.parse(payload));
        if (restored) setReport(restored);
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
      void invoke("save_workspace_draft", { variant: "strips", payload: JSON.stringify(report) })
        .then(() => setDraftStatus("saved"))
        .catch(() => setDraftStatus("error"));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [draftReady, report, tauriAvailable]);

  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(""), 10_000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  useEffect(() => {
    if (!donePath) return;
    const timeout = window.setTimeout(() => setDonePath(""), 10_000);
    return () => window.clearTimeout(timeout);
  }, [donePath]);

  useEffect(() => {
    if (draftStatus !== "error") return;
    const timeout = window.setTimeout(() => setDraftStatus("saved"), 10_000);
    return () => window.clearTimeout(timeout);
  }, [draftStatus]);

  function updateStrip(stripId: string, update: (strip: WorkStrip) => WorkStrip) {
    setReport((current) => ({
      ...current,
      strips: current.strips.map((strip) => strip.id === stripId ? update(strip) : strip),
    }));
  }

  function updateGroup(stripId: string, groupId: string, update: (group: StripGroup) => StripGroup) {
    updateStrip(stripId, (strip) => ({
      ...strip,
      groups: strip.groups.map((group) => group.id === groupId ? update(group) : group),
    }));
  }

  function updateTypeRun(stripId: string, groupId: string, uavType: UavType) {
    updateStrip(stripId, (strip) => {
      const start = strip.groups.findIndex((group) => group.id === groupId);
      if (start < 0) return strip;
      const previousType = strip.groups[start].uavType;
      let end = start + 1;
      while (previousType && end < strip.groups.length && strip.groups[end].uavType === previousType) end += 1;
      return {
        ...strip,
        groups: strip.groups.map((group, index) => index >= start && index < end
          ? { ...group, uavType }
          : group),
      };
    });
  }

  function addUnitToType(stripId: string, groupId: string) {
    updateStrip(stripId, (strip) => {
      const start = strip.groups.findIndex((group) => group.id === groupId);
      if (start < 0 || !strip.groups[start].uavType) return strip;
      const uavType = strip.groups[start].uavType;
      let insertAt = start + 1;
      while (insertAt < strip.groups.length && strip.groups[insertAt].uavType === uavType) insertAt += 1;
      const group = { ...createGroup(), uavType };
      const groups = [...strip.groups];
      groups.splice(insertAt, 0, group);
      return { ...strip, groups };
    });
  }

  function updatePosition(
    stripId: string,
    groupId: string,
    positionId: string,
    update: (position: StripPosition) => StripPosition,
  ) {
    updateGroup(stripId, groupId, (group) => ({
      ...group,
      positions: group.positions.map((position) => position.id === positionId ? update(position) : position),
    }));
  }

  function updateCrew(
    stripId: string,
    groupId: string,
    positionId: string | null,
    crewId: string,
    update: (crew: StripCrew) => StripCrew,
  ) {
    updateGroup(stripId, groupId, (group) => positionId
      ? {
          ...group,
          positions: group.positions.map((position) => position.id === positionId
            ? { ...position, crews: position.crews.map((crew) => crew.id === crewId ? update(crew) : crew) }
            : position),
        }
      : {
          ...group,
          looseCrews: group.looseCrews.map((crew) => crew.id === crewId ? update(crew) : crew),
        });
  }

  function requestPositionReadiness(
    stripId: string,
    groupId: string,
    position: StripPosition,
    readiness: PositionReadiness,
  ) {
    if (readiness === "Не БГ") {
      setPendingReason({
        target: { kind: "position", stripId, groupId, positionId: position.id },
        value: position.readiness === "Не БГ" ? position.notReadyReason : "",
      });
      return;
    }
    updateGroup(stripId, groupId, (group) => setPositionReadinessInGroup(
      group,
      position.id,
      readiness,
    ));
  }

  function requestCrewReadiness(
    stripId: string,
    groupId: string,
    positionId: string | null,
    crew: StripCrew,
    readiness: CrewReadiness,
  ) {
    if (readiness === "Не БГ") {
      setPendingReason({
        target: { kind: "crew", stripId, groupId, positionId, crewId: crew.id },
        value: crew.readiness === "Не БГ" ? crew.notReadyReason : "",
      });
      return;
    }
    updateGroup(stripId, groupId, (group) => setCrewReadinessInGroup(
      group,
      positionId,
      crew.id,
      readiness,
    ));
  }

  function commitNotReady() {
    if (!pendingReason?.value.trim()) return;
    const { target, value } = pendingReason;
    if (target.kind === "position") {
      updateGroup(target.stripId, target.groupId, (group) => setPositionReadinessInGroup(
        group,
        target.positionId,
        "Не БГ",
        value,
      ));
    } else {
      updateGroup(target.stripId, target.groupId, (group) => setCrewReadinessInGroup(
        group,
        target.positionId,
        target.crewId,
        "Не БГ",
        value,
      ));
    }
    setPendingReason(null);
  }

  function confirmAction() {
    const action = pendingConfirmation?.action;
    setPendingConfirmation(null);
    action?.();
  }

  function linkCrew(crewId: string) {
    if (!pendingLink) return;
    updateGroup(pendingLink.stripId, pendingLink.groupId, (group) => attachLooseCrew(
      group,
      pendingLink.positionId,
      crewId,
    ));
    setPendingLink(null);
  }

  function addStrip() {
    setReport((current) => ({
      ...current,
      strips: [...current.strips, createStrip(`Смуга ${current.strips.length + 1}`)],
    }));
  }

  function removeStrip(stripId: string) {
    const strip = report.strips.find((item) => item.id === stripId);
    setPendingConfirmation({
      title: "Підтвердьте видалення",
      label: `Видалити смугу «${strip?.name || "Без назви"}» разом з усіма її блоками?`,
      confirmLabel: "Видалити",
      danger: true,
      action: () => setReport((current) => ({
        ...current,
        strips: current.strips.filter((item) => item.id !== stripId),
      })),
    });
  }

  function moveStrip(index: number, direction: -1 | 1) {
    setReport((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.strips.length) return current;
      const strips = [...current.strips];
      [strips[index], strips[nextIndex]] = [strips[nextIndex], strips[index]];
      return { ...current, strips };
    });
  }

  function changeTableZoom(direction: -1 | 1) {
    const currentIndex = TABLE_ZOOM_STEPS.findIndex((value) => value === tableZoom);
    const fallbackIndex = TABLE_ZOOM_STEPS.findIndex((value) => value >= tableZoom);
    const baseIndex = currentIndex >= 0 ? currentIndex : Math.max(0, fallbackIndex);
    const nextIndex = Math.min(TABLE_ZOOM_STEPS.length - 1, Math.max(0, baseIndex + direction));
    setTableZoom(TABLE_ZOOM_STEPS[nextIndex]);
  }

  async function exportWorkbook() {
    if (validationErrors.length > 0) {
      setError(`Виправте всі помилки перед експортом (${validationErrors.length}):\n${validationErrors.map((problem) => `• ${problem}`).join("\n")}`);
      return;
    }
    const outputPath = await save({
      title: "Зберегти позиції по смугах",
      defaultPath: `Позиції по смугах ${formatDate(report.reportDate)}.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!outputPath) return;
    setBusy(true);
    setError("");
    setDonePath("");
    try {
      const saved = await invoke<string>("export_strips_workbook", {
        request: { ...report, outputPath },
      });
      setDonePath(saved);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell strips-shell">
      {error && <Notification kind="error">{error}</Notification>}
      {donePath && <Notification kind="success">Файл збережено: {donePath}</Notification>}
      {pendingReason && (
        <ReasonModal
          value={pendingReason.value}
          onChange={(value) => setPendingReason((current) => current ? { ...current, value } : current)}
          onCancel={() => setPendingReason(null)}
          onSave={commitNotReady}
        />
      )}
      {pendingConfirmation && (
        <ConfirmationModal
          title={pendingConfirmation.title}
          label={pendingConfirmation.label}
          confirmLabel={pendingConfirmation.confirmLabel}
          danger={pendingConfirmation.danger}
          onCancel={() => setPendingConfirmation(null)}
          onConfirm={confirmAction}
        />
      )}
      {pendingLinkContext && (
        <LinkCrewModal
          position={pendingLinkContext.position}
          crews={pendingLinkContext.group.looseCrews}
          onCancel={() => setPendingLink(null)}
          onSelect={linkCrew}
        />
      )}

      <section className="workspace-panel strips-document-panel">
        <div className="bcs-toolbar strips-toolbar">
          <button type="button" className="secondary-button" onClick={addStrip}><Plus size={16} /> Додати смугу</button>
          <label className="strips-toolbar-date">
            <span>Дата звіту</span>
            <input
              type="date"
              value={report.reportDate}
              onChange={(event) => setReport((current) => ({ ...current, reportDate: event.target.value }))}
            />
          </label>
          <div className="bcs-zoom-control" aria-label="Масштаб таблиці">
            <span>Масштаб</span>
            <button type="button" aria-label="Зменшити масштаб" onClick={() => changeTableZoom(-1)} disabled={tableZoom === TABLE_ZOOM_STEPS[0]}><Minus size={15} /></button>
            <output>{tableZoom}%</output>
            <button type="button" aria-label="Збільшити масштаб" onClick={() => changeTableZoom(1)} disabled={tableZoom === TABLE_ZOOM_STEPS[TABLE_ZOOM_STEPS.length - 1]}><Plus size={15} /></button>
          </div>
        </div>

        <div className="strips-table-scroll">
          <div className="strips-table-scale" style={{ "--strips-table-zoom": tableZoom / 100 } as CSSProperties}>
            <div className="strips-sheet-title">
              <strong>Позиції та екіпажі по смугах</strong>
              <span>станом на {formatDate(report.reportDate)}</span>
            </div>

            {report.strips.map((strip, stripIndex) => (
              <section className="strips-section" key={strip.id}>
                <div className="strips-section-toolbar">
                  <div className="strips-section-toolbar-inner">
                    <input
                      aria-label={`Назва смуги ${stripIndex + 1}`}
                      value={strip.name}
                      maxLength={200}
                      onChange={(event) => updateStrip(strip.id, (current) => ({ ...current, name: event.target.value }))}
                    />
                    <div>
                      <button type="button" onClick={() => updateStrip(strip.id, (current) => ({ ...current, groups: [...current.groups, createGroup()] }))}><Plus size={14} /> Тип БпЛА</button>
                      <button type="button" aria-label="Перемістити смугу вище" disabled={stripIndex === 0} onClick={() => moveStrip(stripIndex, -1)}><ArrowUp size={15} /></button>
                      <button type="button" aria-label="Перемістити смугу нижче" disabled={stripIndex === report.strips.length - 1} onClick={() => moveStrip(stripIndex, 1)}><ArrowDown size={15} /></button>
                      <button type="button" className="danger" aria-label="Видалити смугу" onClick={() => removeStrip(strip.id)}><Trash2 size={15} /></button>
                    </div>
                  </div>
                </div>

                <table className="strips-editor-table">
                  <StripsColGroup />
                  <thead><tr>{HEADERS.map((header) => <th key={header}>{header}</th>)}</tr></thead>
                  <tbody>
                    {strip.groups.flatMap((group, groupIndex) => {
                      const rows = groupTableRows(group);
                      const previousType = strip.groups[groupIndex - 1]?.uavType;
                      const isTypeRunStart = !group.uavType || previousType !== group.uavType;
                      let typeRunRowCount = rows.length;
                      if (isTypeRunStart && group.uavType) {
                        for (let index = groupIndex + 1; index < strip.groups.length; index += 1) {
                          if (strip.groups[index].uavType !== group.uavType) break;
                          typeRunRowCount += groupTableRows(strip.groups[index]).length;
                        }
                      }
                      return rows.map((row, groupRowIndex) => {
                        const groupLabel = `${strip.name}, блок ${groupIndex + 1}`;
                        const groupCells = groupRowIndex === 0 ? (
                          <>
                            <td rowSpan={rows.length} className={`strips-group-rowspan-cell${!group.unit.trim() ? " strips-warning-cell" : ""}`}>
                              <div className="strips-group-cell">
                                <input
                                  aria-label={`${groupLabel}: підрозділ`}
                                  value={group.unit}
                                  maxLength={250}
                                  onChange={(event) => updateGroup(strip.id, group.id, (current) => ({ ...current, unit: event.target.value }))}
                                />
                                <div className="strips-group-actions">
                                  <button type="button" title="Додати позицію" onClick={() => updateGroup(strip.id, group.id, (current) => ({ ...current, positions: [...current.positions, createPosition()] }))}><Plus size={13} /> Позиція</button>
                                  <button type="button" title="Додати екіпаж без позиції" onClick={() => updateGroup(strip.id, group.id, (current) => ({ ...current, looseCrews: [...current.looseCrews, createCrew("loose-crew")] }))}><Plus size={13} /> Екіпаж</button>
                                  <button
                                    type="button"
                                    className="danger"
                                    title="Видалити блок"
                                    aria-label={`${groupLabel}: видалити блок`}
                                    onClick={() => setPendingConfirmation({
                                      title: "Підтвердьте видалення",
                                      label: `Видалити блок «${group.unit || "Без назви"} / ${group.uavType || "Тип не вказано"}»?`,
                                      confirmLabel: "Видалити",
                                      danger: true,
                                      action: () => updateStrip(strip.id, (current) => ({
                                        ...current,
                                        groups: current.groups.filter((item) => item.id !== group.id),
                                      })),
                                    })}
                                  ><Trash2 size={13} /></button>
                                </div>
                              </div>
                            </td>
                            {isTypeRunStart && (
                              <td rowSpan={typeRunRowCount} className={`strips-type-rowspan-cell${!group.uavType ? " strips-warning-cell" : ""}`}>
                                <div className="strips-type-cell">
                                  <CustomSelect<UavType>
                                    ariaLabel={`${groupLabel}: тип БпЛА`}
                                    value={group.uavType}
                                    options={uavOptions}
                                    onChange={(value) => updateTypeRun(strip.id, group.id, value)}
                                  />
                                  {group.uavType && (
                                    <div className="strips-type-actions">
                                      <button
                                        type="button"
                                        title={`Додати підрозділ до типу «${group.uavType}»`}
                                        onClick={() => addUnitToType(strip.id, group.id)}
                                      ><Plus size={13} /> Підрозділ</button>
                                    </div>
                                  )}
                                </div>
                              </td>
                            )}
                          </>
                        ) : null;

                        if (row.kind === "empty") {
                          return (
                            <tr className="strips-unmatched-row" key={`${group.id}-empty`}>
                              {groupCells}
                              <td colSpan={10} className="strips-unmatched-label">Додайте позицію або екіпаж без позиції</td>
                            </tr>
                          );
                        }

                        if (row.kind === "loose") {
                          const label = `${groupLabel}, екіпаж без позиції ${row.crewIndex + 1}`;
                          return (
                            <tr className="strips-unmatched-row" key={row.crew.id}>
                              {groupCells}
                              <CrewCells
                                crew={row.crew}
                                label={label}
                                neutral
                                onUpdate={(field, value) => updateCrew(strip.id, group.id, null, row.crew.id, (current) => ({ ...current, [field]: value }))}
                                onReadiness={(value) => requestCrewReadiness(strip.id, group.id, null, row.crew, value)}
                                onRemove={() => setPendingConfirmation({
                                  title: "Підтвердьте видалення",
                                  label: `Видалити екіпаж «${row.crew.name || "Без назви"}»?`,
                                  confirmLabel: "Видалити",
                                  danger: true,
                                  action: () => updateGroup(strip.id, group.id, (current) => ({
                                    ...current,
                                    looseCrews: current.looseCrews.filter((item) => item.id !== row.crew.id),
                                  })),
                                })}
                              />
                              <td colSpan={5} className="strips-status-band status-neutral strips-unmatched-label">
                                <div className="strips-unmatched-actions">
                                  <span>Екіпаж без позиції</span>
                                  {row.crew.readiness !== "Формується" && (
                                    <button
                                      type="button"
                                      title="Створити позицію для цього екіпажу"
                                      onClick={() => updateGroup(strip.id, group.id, (current) => createPositionForLooseCrew(current, row.crew.id))}
                                    >
                                      <MapPinPlus size={14} /> Додати позицію
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td>
                                <textarea
                                  aria-label={`${label}: примітки`}
                                  value={row.crew.note}
                                  maxLength={1000}
                                  rows={3}
                                  onChange={(event) => updateCrew(strip.id, group.id, null, row.crew.id, (current) => ({ ...current, note: event.target.value }))}
                                />
                              </td>
                            </tr>
                          );
                        }

                        const first = row.crewIndex === 0;
                        const position = row.position;
                        const crew = row.crew;
                        const label = `${groupLabel}, позиція ${row.positionIndex + 1}, екіпаж ${row.crewIndex + 1}`;
                        const positionTone = crew ? statusClass(position.readiness) : "status-neutral";
                        const positionReadinessOptions: ReadonlyArray<CustomSelectOption<PositionReadiness>> = POSITION_READINESS.map((value) => ({
                          value,
                          label: value === "Не БГ" ? readinessDisplay(value, position.notReadyReason) : value,
                        }));
                        return (
                          <tr key={crew?.id ?? `${position.id}-empty`}>
                            {groupCells}
                            {crew ? (
                              <CrewCells
                                crew={crew}
                                label={label}
                                onUpdate={(field, value) => updateCrew(strip.id, group.id, position.id, crew.id, (current) => ({ ...current, [field]: value }))}
                                onReadiness={(value) => requestCrewReadiness(strip.id, group.id, position.id, crew, value)}
                                onDetach={() => updateGroup(strip.id, group.id, (current) => detachCrew(current, position.id, crew.id))}
                                onRemove={() => setPendingConfirmation({
                                  title: "Підтвердьте видалення",
                                  label: `Видалити екіпаж «${crew.name || "Без назви"}»?`,
                                  confirmLabel: "Видалити",
                                  danger: true,
                                  action: () => updatePosition(strip.id, group.id, position.id, (current) => ({
                                    ...current,
                                    crews: current.crews.filter((item) => item.id !== crew.id),
                                  })),
                                })}
                              />
                            ) : (
                              <td colSpan={4} className="strips-status-band status-neutral strips-unmatched-label">
                                Позиція без екіпажу
                              </td>
                            )}
                            {first && (
                              <>
                                <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}${!position.name.trim() ? " strips-warning-cell" : ""}`}>
                                  <div className="strips-position-cell">
                                    <input aria-label={`${groupLabel}: позиція`} value={position.name} maxLength={250} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, name: event.target.value }))} />
                                    <div className="strips-position-actions">
                                      <button
                                        type="button"
                                        title="Створити новий екіпаж у цій позиції"
                                        aria-label="Додати новий екіпаж до позиції"
                                        onClick={() => updatePosition(strip.id, group.id, position.id, (current) => ({
                                          ...current,
                                          crews: [...current.crews, createCrewForPosition(current)],
                                        }))}
                                      ><Plus size={13} /> Новий</button>
                                      <button
                                        type="button"
                                        title="Приєднати наявний екіпаж без позиції"
                                        aria-label="Приєднати наявний екіпаж до позиції"
                                        onClick={() => setPendingLink({ stripId: strip.id, groupId: group.id, positionId: position.id })}
                                      ><Link2 size={13} /> Приєднати</button>
                                      <button
                                        type="button"
                                        className="danger"
                                        aria-label="Видалити позицію"
                                        onClick={() => setPendingConfirmation({
                                          title: "Підтвердьте видалення",
                                          label: `Видалити позицію «${position.name || "Без назви"}» разом з її екіпажами?`,
                                          confirmLabel: "Видалити",
                                          danger: true,
                                          action: () => updateGroup(strip.id, group.id, (current) => ({
                                            ...current,
                                            positions: current.positions.filter((item) => item.id !== position.id),
                                          })),
                                        })}
                                      ><Trash2 size={14} /></button>
                                    </div>
                                  </div>
                                </td>
                                <td rowSpan={row.positionRowCount} className={`strips-status-band strips-status-cell strips-rowspan-select-cell ${positionTone}${!position.readiness ? " strips-warning-cell" : ""}`}>
                                  <CustomSelect ariaLabel={`${groupLabel}: БГ позиції`} value={position.readiness} options={positionReadinessOptions} onChange={(value) => requestPositionReadiness(strip.id, group.id, position, value)} />
                                </td>
                                <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}${!position.bro.trim() ? " strips-warning-cell" : ""}`}>
                                  <input aria-label={`${groupLabel}: БРО`} value={position.bro} maxLength={250} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, bro: event.target.value }))} />
                                </td>
                                <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}${!position.area.trim() ? " strips-warning-cell" : ""}`}>
                                  <input aria-label={`${groupLabel}: район`} value={position.area} maxLength={250} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, area: upperUk(event.target.value) }))} />
                                </td>
                                <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}${!position.direction.trim() ? " strips-warning-cell" : ""}`}>
                                  <textarea aria-label={`${groupLabel}: напрямок роботи`} value={position.direction} maxLength={500} rows={3} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, direction: event.target.value }))} />
                                </td>
                                <td rowSpan={row.positionRowCount}>
                                  <textarea aria-label={`${groupLabel}: примітки до позиції`} value={position.note} maxLength={1000} rows={3} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, note: event.target.value }))} />
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
                <StripSummaryRow strip={strip} />
              </section>
            ))}

            <SummaryTables summary={summary} />
          </div>
        </div>
      </section>

      <footer className="export-bar strips-export-bar">
        <div>
          <b>{validationErrors.length > 0 ? `Експорт недоступний: ${validationCountLabel(validationErrors.length)}` : "Готово до експорту"}</b>
          {validationErrors.length > 0 && (
            <ol className="strips-validation-list">
              {validationErrors.map((problem, index) => <li key={`${index}-${problem}`}>{problem}</li>)}
            </ol>
          )}
          {tauriAvailable && (
            <span className={draftStatus === "error" ? "autosave-error" : "autosave-status"}>
              {draftStatus === "saving" && "Зберігаю зміни…"}
              {draftStatus === "saved" && "Зміни збережено"}
              {draftStatus === "error" && "Не вдалося зберегти чернетку"}
            </span>
          )}
        </div>
        <button className="primary-button" onClick={exportWorkbook} disabled={busy || validationErrors.length > 0} title={validationErrors.join("\n") || undefined}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
          Зберегти у XLSX
        </button>
      </footer>
    </main>
  );
}
