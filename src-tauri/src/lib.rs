mod bcs;
mod bcs_rules;
mod draft;
mod editor_import;
mod generator;
mod strips;
mod xlsx;

use bcs::{ComparisonRequest, ComparisonResult, ExportRequest, ImportPreview};
use generator::{FilledBcsRequest, TemplateRequest};
use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
fn import_bcs_files(paths: Vec<String>) -> Result<ImportPreview, String> {
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    bcs::preview_files(&paths)
}

#[tauri::command]
fn export_summary(request: ExportRequest) -> Result<String, String> {
    bcs::export_request(request)
}

#[tauri::command]
fn compare_bcs_files(request: ComparisonRequest) -> Result<ComparisonResult, String> {
    bcs::compare_request(request)
}

#[tauri::command]
fn export_bcs_template(request: TemplateRequest) -> Result<String, String> {
    generator::export_template(request)
}

#[tauri::command]
fn export_filled_bcs(request: FilledBcsRequest) -> Result<String, String> {
    generator::export_filled(request)
}

#[tauri::command]
fn import_bcs_editor(path: String) -> Result<editor_import::ImportedEditorWorkspace, String> {
    editor_import::import_bcs_editor(path)
}

#[tauri::command]
fn export_strips_workbook(request: strips::StripsExportRequest) -> Result<String, String> {
    strips::export_strips(request)
}

#[tauri::command]
fn import_strips_registry(path: String) -> Result<strips::ImportedStripsRegistry, String> {
    strips::import_strips_registry(path)
}

#[tauri::command]
fn save_workspace_draft(
    app: tauri::AppHandle,
    variant: String,
    payload: String,
) -> Result<(), String> {
    draft::save(app, variant, payload)
}

#[tauri::command]
fn load_workspace_draft(app: tauri::AppHandle, variant: String) -> Result<Option<String>, String> {
    draft::load(app, variant)
}

#[tauri::command]
fn backup_workspace_draft(
    app: tauri::AppHandle,
    variant: String,
) -> Result<Option<String>, String> {
    draft::backup(app, variant)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            import_bcs_files,
            export_summary,
            compare_bcs_files,
            export_bcs_template,
            export_filled_bcs,
            import_bcs_editor,
            export_strips_workbook,
            import_strips_registry,
            save_workspace_draft,
            load_workspace_draft,
            backup_workspace_draft
        ])
        .build(tauri::generate_context!())
        .expect("error while building SummaryBCS")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Cmd+Q and the native Quit menu must follow the same close
                // request as the title-bar button, so the editor can flush.
                // Once that window is destroyed, there is no main window and
                // the next exit request is allowed through normally.
                if let Some(window) = app.get_webview_window("main") {
                    api.prevent_exit();
                    if let Err(error) = window.close() {
                        eprintln!("Could not request a safe window close: {error}");
                    }
                }
            }
        });
}
