mod bcs;
mod draft;
mod generator;
mod strips;
mod xlsx;

use bcs::{ComparisonRequest, ComparisonResult, ExportRequest, ImportPreview};
use generator::{FilledBcsRequest, TemplateRequest};
use std::path::PathBuf;

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
fn export_strips_workbook(request: strips::StripsExportRequest) -> Result<String, String> {
    strips::export_strips(request)
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
            export_strips_workbook,
            save_workspace_draft,
            load_workspace_draft
        ])
        .run(tauri::generate_context!())
        .expect("error while running SummaryBCS");
}
