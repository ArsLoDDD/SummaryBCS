import type { DragDropEvent } from "@tauri-apps/api/webviewWindow";
import type { ImportPreview } from "./model";

export type ComparisonSide = "before" | "after";

function pathKey(path: string): string {
  // Windows paths are case insensitive; Unix paths can be case sensitive.
  const windowsPath = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\") || path.startsWith("//");
  return windowsPath ? path.replaceAll("\\", "/").toLocaleLowerCase("en-US") : path;
}

export function mergeSummaryFilePaths(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...existing, ...incoming].filter((path) => {
    if (!path.trim()) return false;
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function importSummaryFileBatch(
  current: ImportPreview | null,
  incoming: readonly string[],
  load: (paths: string[]) => Promise<ImportPreview>,
): Promise<ImportPreview | null> {
  const existing = current?.units.map((unit) => unit.path) ?? [];
  const paths = mergeSummaryFilePaths(existing, incoming);
  if (paths.length === existing.length) return current;
  // Revalidate all files together so mixed dates or duplicate units are rejected.
  return load(paths);
}

export function appendComparisonFileBatch(
  current: { before: string[]; after: string[] },
  side: ComparisonSide,
  incoming: readonly string[],
): { before: string[]; after: string[] } {
  return { ...current, [side]: mergeSummaryFilePaths(current[side], incoming) };
}

type Bounds = { left: number; right: number; top: number; bottom: number };

export function comparisonDropSide(
  position: { x: number; y: number },
  bounds: { before?: Bounds; after?: Bounds },
  fallback: ComparisonSide,
  scaleFactor: number,
): ComparisonSide {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  const x = position.x / scale;
  const y = position.y / scale;
  for (const side of ["before", "after"] as const) {
    const rect = bounds[side];
    if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return side;
  }
  return fallback;
}

export function nativeFileDropAction(
  event: DragDropEvent,
  busy: boolean,
  reordering = false,
): { dragging: boolean; paths?: string[] } {
  if (busy || reordering || event.type === "leave") return { dragging: false };
  if (event.type === "drop") return { dragging: false, paths: event.paths };
  return { dragging: true };
}
