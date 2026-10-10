import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  FileSpreadsheet,
  GripVertical,
  LoaderCircle,
} from "lucide-react";
import { type ImportPreview, moveUnit } from "./model";

function messageFrom(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Сталася неочікувана помилка.";
}

export default function SummaryApp() {
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
    const paths = Array.isArray(selected) ? selected : [selected];
    await importPaths(paths);
  }

  useEffect(() => {
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
        .catch(() => {
          // У браузерному перегляді лишається звичайна кнопка вибору файлів.
        });
    } catch {
      // У браузерному перегляді API вікна Tauri недоступне.
    }

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [busy, importPaths, preview]);

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
    <main className="app-shell summary-shell">
      <header className="app-header">
        <div>
          <h1>Зведення БЧС</h1>
          <p>Об’єднання XLSX-файлів підрозділів в один звіт</p>
        </div>
      </header>

      {error && <div className="message error" role="alert">{error}</div>}
      {donePath && <div className="message success" role="status">Файл збережено: {donePath}</div>}

      {!preview ? (
        <section className={`empty-panel${isDraggingFiles ? " dragging" : ""}`}>
          <FileSpreadsheet size={40} aria-hidden="true" />
          <h2>{isDraggingFiles ? "Відпустіть файли тут" : "Оберіть файли БЧС"}</h2>
          <p>Перетягніть XLSX-файли сюди або скористайтеся кнопкою.</p>
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
    </main>
  );
}
