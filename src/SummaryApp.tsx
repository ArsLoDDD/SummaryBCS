import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  FileSpreadsheet,
  GitCompareArrows,
  GripVertical,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  type ComparisonMetric,
  type ComparisonResult,
  type ImportPreview,
  moveUnit,
} from "./model";

type AppTab = "summary" | "comparison";
type ComparisonSide = "before" | "after";

function messageFrom(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Сталася неочікувана помилка.";
}

function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function Notification({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  return <div className={`message ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

function SummaryWorkflow({ active }: { active: boolean }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [donePath, setDonePath] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const draggedIndex = useRef<number | null>(null);

  const order = useMemo(() => preview?.units.map((unit) => unit.id) ?? [], [preview]);

  const importPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy(true);
    setError("");
    setDonePath("");
    try {
      const next = await invoke<ImportPreview>("import_bcs_files", { paths });
      setPreview(next);
    } catch (cause) {
      setPreview(null);
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  async function chooseFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Excel БЧС", extensions: ["xlsx"] }],
      title: "Оберіть файли БЧС",
    });
    if (!selected) return;
    await importPaths(Array.isArray(selected) ? selected : [selected]);
  }

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let stopListening: (() => void) | undefined;
    try {
      getCurrentWebviewWindow()
        .onDragDropEvent((event) => {
          if (preview || busy) return;
          if (event.payload.type === "over") {
            setIsDraggingFiles(true);
          } else if (event.payload.type === "leave") {
            setIsDraggingFiles(false);
          } else if (event.payload.type === "drop") {
            setIsDraggingFiles(false);
            void importPaths(event.payload.paths);
          }
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stopListening = unlisten;
        })
        .catch(() => undefined);
    } catch {
      // У браузерному перегляді API вікна Tauri недоступне.
    }
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [active, busy, importPaths, preview]);

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

  function reorder(from: number, to: number) {
    setPreview((current) =>
      current ? { ...current, units: moveUnit(current.units, from, to) } : current,
    );
  }

  async function exportFile() {
    if (!preview) return;
    const outputPath = await save({
      title: "Зберегти зведений БЧС",
      defaultPath: `Зведення_БЧС_${preview.date.replaceAll(".", "-")}.xlsx`,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (!outputPath) return;

    setBusy(true);
    setError("");
    setDonePath("");
    try {
      const saved = await invoke<string>("export_summary", {
        request: {
          paths: preview.units.map((unit) => unit.path),
          unitOrder: order,
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

  return (
    <>
      {error && <Notification kind="error">{error}</Notification>}
      {donePath && <Notification kind="success">Файл збережено: {donePath}</Notification>}

      {!preview ? (
        <section className={`empty-panel${isDraggingFiles ? " dragging" : ""}`}>
          <FileSpreadsheet size={40} aria-hidden="true" />
          <h2>{isDraggingFiles ? "Відпустіть файли тут" : "Оберіть файли підрозділів"}</h2>
          <p>Додайте щонайменше два XLSX-файли БЧС за одну дату.</p>
          <button className="primary-button" onClick={chooseFiles} disabled={busy}>
            {busy && <LoaderCircle className="spin" size={18} />}
            Обрати файли
          </button>
        </section>
      ) : (
        <section className="content-panel">
          <div className="panel-header">
            <div>
              <h2>Підрозділи</h2>
              <p>Перетягніть рядки, щоб змінити порядок у файлі.</p>
            </div>
            <button className="text-button" onClick={chooseFiles} disabled={busy}>Обрати інші файли</button>
          </div>

          <div className="summary-line">
            <span>Дата: <b>{preview.date}</b></span>
            <span>Підрозділів: <b>{preview.units.length}</b></span>
            <span>Особового складу: <b>{preview.totalPersonnel}</b></span>
          </div>

          <ol className="unit-list">
            {preview.units.map((unit, index) => (
              <li
                key={unit.id}
                draggable
                onDragStart={() => { draggedIndex.current = index; }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (draggedIndex.current !== null) reorder(draggedIndex.current, index);
                  draggedIndex.current = null;
                }}
              >
                <GripVertical className="drag-handle" size={20} aria-hidden="true" />
                <span className="order-number">{index + 1}</span>
                <div className="unit-main">
                  <strong>{unit.unitName}</strong>
                  <span>{unit.fileName} · {unit.personnelCount} осіб · {unit.authorizedStrength} за штатом</span>
                </div>
                <div className="reorder-buttons">
                  <button aria-label={`Перемістити ${unit.unitName} вище`} disabled={index === 0} onClick={() => reorder(index, index - 1)}><ArrowUp size={17} /></button>
                  <button aria-label={`Перемістити ${unit.unitName} нижче`} disabled={index === preview.units.length - 1} onClick={() => reorder(index, index + 1)}><ArrowDown size={17} /></button>
                </div>
              </li>
            ))}
          </ol>

          <footer className="action-row">
            <span>Рядків у таблиці: {preview.totalRows}</span>
            <button className="primary-button" onClick={exportFile} disabled={busy}>
              {busy && <LoaderCircle className="spin" size={18} />}
              Сформувати XLSX
            </button>
          </footer>
        </section>
      )}
    </>
  );
}

function ComparisonFileGroup({
  side,
  paths,
  active,
  onActivate,
  onChoose,
  onClear,
}: {
  side: ComparisonSide;
  paths: string[];
  active: boolean;
  onActivate: () => void;
  onChoose: () => void;
  onClear: () => void;
}) {
  const first = side === "before";
  return (
    <section
      className={`comparison-file-card${active ? " active" : ""}`}
      onMouseEnter={onActivate}
      onClick={onActivate}
    >
      <div className="comparison-file-heading">
        <div>
          <span className="comparison-step">{first ? "1" : "2"}</span>
          <div>
            <h2>{first ? "Перша дата" : "Друга дата"}</h2>
            <p>{first ? "БЧС, з якого починаємо" : "БЧС, з яким порівнюємо"}</p>
          </div>
        </div>
        {paths.length > 0 && (
          <button className="icon-button comparison-clear" onClick={(event) => { event.stopPropagation(); onClear(); }} aria-label="Прибрати файли">
            <X size={17} />
          </button>
        )}
      </div>
      {paths.length === 0 ? (
        <button className="comparison-picker" onClick={(event) => { event.stopPropagation(); onChoose(); }}>
          <FileSpreadsheet size={26} aria-hidden="true" />
          <span>Обрати XLSX-файл або кілька файлів</span>
        </button>
      ) : (
        <div className="comparison-files">
          <strong>{paths.length === 1 ? "1 файл" : `${paths.length} файлів`}</strong>
          <ul>
            {paths.map((path) => <li key={path} title={path}>{fileName(path)}</li>)}
          </ul>
          <button className="text-button" onClick={(event) => { event.stopPropagation(); onChoose(); }}>Замінити</button>
        </div>
      )}
    </section>
  );
}

function Delta({ row }: { row: ComparisonMetric }) {
  const sign = row.delta > 0 ? "+" : "";
  const state = row.delta > 0 ? "positive" : row.delta < 0 ? "negative" : "neutral";
  return <span className={`delta ${state}`}>{sign}{row.delta}</span>;
}

function ComparisonTable({ rows }: { rows: ComparisonMetric[] }) {
  return (
    <div className="comparison-table" role="table">
      <div className="comparison-table-head" role="row">
        <span>Показник</span><span>Було</span><span>Стало</span><span>Зміна</span>
      </div>
      {rows.map((row) => (
        <div className="comparison-table-row" role="row" key={row.label}>
          <strong>{row.label}</strong>
          <span>{row.before}</span>
          <span>{row.after}</span>
          <Delta row={row} />
        </div>
      ))}
    </div>
  );
}

function ComparisonResults({ result }: { result: ComparisonResult }) {
  const added = result.personnelChanges.filter((item) => item.kind === "added").length;
  const removed = result.personnelChanges.filter((item) => item.kind === "removed").length;
  const changed = result.personnelChanges.filter((item) => item.kind === "changed").length;

  return (
    <section className="comparison-result" aria-live="polite">
      <div className="comparison-result-heading">
        <div>
          <span className="comparison-scope">{result.scope === "unit" ? "Один підрозділ" : "Загальне порівняння"}</span>
          <h2>{result.title}</h2>
          <p>{result.beforeDate} → {result.afterDate}</p>
        </div>
        {!result.hasChanges && <span className="no-changes">Змін не виявлено</span>}
      </div>

      <div className="comparison-highlights">
        {result.highlights.map((item) => <p key={item}>{item}</p>)}
      </div>

      <ComparisonTable rows={result.headline} />

      {result.unitChanges.length > 0 && (
        <details className="comparison-details" open>
          <summary>Зміни по підрозділах <span>{result.unitChanges.length}</span></summary>
          <ul className="change-list">
            {result.unitChanges.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </details>
      )}

      {result.sections.map((section) => (
        <details className="comparison-details" open key={section.title}>
          <summary>{section.title} <span>{section.rows.length}</span></summary>
          <ComparisonTable rows={section.rows} />
        </details>
      ))}

      {result.personnelChanges.length > 0 && (
        <details className="comparison-details personnel-changes">
          <summary>Зміни по людях <span>додано {added} · вибуло {removed} · змінено {changed}</span></summary>
          <div className="personnel-change-list">
            {result.personnelChanges.map((item, index) => (
              <div className={`personnel-change ${item.kind}`} key={`${item.kind}-${item.personName}-${index}`}>
                <strong>{item.personName}</strong>
                <span>{item.details}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ComparisonWorkflow({ active }: { active: boolean }) {
  const [beforePaths, setBeforePaths] = useState<string[]>([]);
  const [afterPaths, setAfterPaths] = useState<string[]>([]);
  const [activeSide, setActiveSide] = useState<ComparisonSide>("before");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ComparisonResult | null>(null);

  const setPaths = useCallback((side: ComparisonSide, paths: string[]) => {
    if (side === "before") setBeforePaths(paths);
    else setAfterPaths(paths);
    setResult(null);
  }, []);

  async function chooseFiles(side: ComparisonSide) {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Excel БЧС", extensions: ["xlsx"] }],
      title: side === "before" ? "Оберіть БЧС за першу дату" : "Оберіть БЧС за другу дату",
    });
    if (!selected) return;
    setPaths(side, Array.isArray(selected) ? selected : [selected]);
    setActiveSide(side === "before" ? "after" : "before");
  }

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let stopListening: (() => void) | undefined;
    try {
      getCurrentWebviewWindow()
        .onDragDropEvent((event) => {
          if (busy) return;
          if (event.payload.type === "over") {
            setIsDraggingFiles(true);
          } else if (event.payload.type === "leave") {
            setIsDraggingFiles(false);
          } else if (event.payload.type === "drop") {
            setIsDraggingFiles(false);
            const target = beforePaths.length === 0
              ? "before"
              : afterPaths.length === 0
                ? "after"
                : activeSide;
            setPaths(target, event.payload.paths);
            setActiveSide(target === "before" ? "after" : "before");
          }
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stopListening = unlisten;
        })
        .catch(() => undefined);
    } catch {
      // У браузерному перегляді API вікна Tauri недоступне.
    }
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [active, activeSide, afterPaths.length, beforePaths.length, busy, setPaths]);

  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(""), 10_000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  async function compare() {
    if (beforePaths.length === 0 || afterPaths.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const comparison = await invoke<ComparisonResult>("compare_bcs_files", {
        request: { beforePaths, afterPaths },
      });
      setResult(comparison);
    } catch (cause) {
      setResult(null);
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <Notification kind="error">{error}</Notification>}
      <section className={`comparison-workflow${isDraggingFiles ? " dragging" : ""}`}>
        <div className="comparison-intro">
          <GitCompareArrows size={24} aria-hidden="true" />
          <div>
            <h1>Порівняння БЧС</h1>
            <p>Один файл — БЧС підрозділу або готовий загальний БЧС. Кілька файлів — загальне порівняння підрозділів.</p>
          </div>
        </div>

        <div className="comparison-file-grid">
          <ComparisonFileGroup
            side="before"
            paths={beforePaths}
            active={activeSide === "before" && isDraggingFiles}
            onActivate={() => setActiveSide("before")}
            onChoose={() => void chooseFiles("before")}
            onClear={() => setPaths("before", [])}
          />
          <ComparisonFileGroup
            side="after"
            paths={afterPaths}
            active={activeSide === "after" && isDraggingFiles}
            onActivate={() => setActiveSide("after")}
            onChoose={() => void chooseFiles("after")}
            onClear={() => setPaths("after", [])}
          />
        </div>

        {isDraggingFiles && <p className="drop-help">Відпустіть файли — вони потраплять у виділений блок.</p>}

        <div className="comparison-actions">
          <span>Файли в кожному блоці мають бути за одну дату.</span>
          <button className="primary-button" disabled={busy || beforePaths.length === 0 || afterPaths.length === 0} onClick={() => void compare()}>
            {busy && <LoaderCircle className="spin" size={18} />}
            Порівняти
          </button>
        </div>
      </section>

      {result && <ComparisonResults result={result} />}
    </>
  );
}

export default function SummaryApp() {
  const [tab, setTab] = useState<AppTab>("summary");

  return (
    <main className="app-shell summary-shell">
      <nav className="summary-tabs" role="tablist" aria-label="Режим роботи">
        <button
          role="tab"
          aria-selected={tab === "summary"}
          className={tab === "summary" ? "active" : ""}
          onClick={() => setTab("summary")}
        >
          Зведення
        </button>
        <button
          role="tab"
          aria-selected={tab === "comparison"}
          className={tab === "comparison" ? "active" : ""}
          onClick={() => setTab("comparison")}
        >
          Порівняння
        </button>
      </nav>

      <div role="tabpanel" hidden={tab !== "summary"}>
        <SummaryWorkflow active={tab === "summary"} />
      </div>
      <div role="tabpanel" hidden={tab !== "comparison"}>
        <ComparisonWorkflow active={tab === "comparison"} />
      </div>
    </main>
  );
}
