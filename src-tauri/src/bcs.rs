use crate::xlsx::{self, Cell, SheetRow};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
};
use zip::ZipArchive;

#[derive(Debug, Clone, Deserialize)]
struct Schema {
    headers: Vec<String>,
    widths: Vec<f64>,
    locations: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct BcsRow {
    is_temporary: bool,
    is_external: bool,
    color_key: String,
    group_key: String,
    section: String,
    position_name: String,
    battle_order: String,
    sector: String,
    crew_name: String,
    crew_actual: String,
    crew_official: String,
    crew_status: String,
    uav_name: String,
    uav_type: String,
    personnel_position: String,
    rank: String,
    full_name: String,
    duties: String,
    location: String,
    notes: String,
}

impl BcsRow {
    fn values(&self) -> [&str; 16] {
        [
            &self.section,
            &self.position_name,
            &self.battle_order,
            &self.sector,
            &self.crew_name,
            &self.crew_actual,
            &self.crew_official,
            &self.crew_status,
            &self.uav_name,
            &self.uav_type,
            &self.personnel_position,
            &self.rank,
            &self.full_name,
            &self.duties,
            &self.location,
            &self.notes,
        ]
    }
}

#[derive(Debug, Clone)]
struct ParsedBcs {
    id: String,
    path: PathBuf,
    file_name: String,
    unit_name: String,
    date: String,
    authorized_strength: i64,
    rows: Vec<BcsRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitPreview {
    id: String,
    path: String,
    file_name: String,
    unit_name: String,
    date: String,
    row_count: usize,
    personnel_count: usize,
    authorized_strength: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    date: String,
    total_rows: usize,
    total_personnel: usize,
    units: Vec<UnitPreview>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    paths: Vec<String>,
    unit_order: Vec<String>,
    output_path: String,
}

fn schema() -> Result<Schema, String> {
    serde_json::from_str(include_str!("../../src/shared/bcs-schema.json"))
        .map_err(|_| "Вбудована схема БЧС пошкоджена.".to_string())
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn cell(row: &SheetRow, column: usize) -> &Cell {
    static EMPTY: std::sync::OnceLock<Cell> = std::sync::OnceLock::new();
    row.cells
        .get(column)
        .unwrap_or_else(|| EMPTY.get_or_init(Cell::default))
}

fn authorized_strength_from_rows(
    sheet_rows: &[SheetRow],
    authorized_row: &SheetRow,
    file_name: &str,
) -> Result<i64, String> {
    let summary_value = cell(authorized_row, 6);
    if !summary_value.has_formula {
        return parse_integer(&summary_value.value, "Значення «По штату»");
    }

    // The universal template links its summary to the yellow H3 input cell.
    // We never execute that formula. We read only the directly stored number
    // from H3 and still reject a formula or missing value there.
    let top_input = sheet_rows
        .iter()
        .find(|row| row.number == 3)
        .map(|row| cell(row, 7))
        .ok_or_else(|| {
            format!(
                "«{file_name}»: формула «По штату» дозволена лише для шаблону з прямим числом у H3."
            )
        })?;
    if top_input.has_formula || top_input.value.trim().is_empty() {
        return Err(format!(
            "«{file_name}»: у H3 має бути збережене число «По штату», а не формула."
        ));
    }
    parse_integer(&top_input.value, "Значення «По штату» у H3")
}

fn valid_date(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() != 2 || parts[1].len() != 2 || parts[2].len() != 4 {
        return false;
    }
    let Ok(day) = parts[0].parse::<u8>() else {
        return false;
    };
    let Ok(month) = parts[1].parse::<u8>() else {
        return false;
    };
    let Ok(year) = parts[2].parse::<u16>() else {
        return false;
    };
    (1..=31).contains(&day) && (1..=12).contains(&month) && year >= 2000
}

fn date_from_title(title: &str) -> Option<String> {
    let marker = "станом на 08:00 год ";
    let tail = title.split_once(marker)?.1;
    let date = tail.split_once(" року").map(|(date, _)| date.trim())?;
    valid_date(date).then(|| date.to_string())
}

fn parse_integer(value: &str, label: &str) -> Result<i64, String> {
    let trimmed = value.trim();
    let parsed = if let Ok(integer) = trimmed.parse::<i64>() {
        integer
    } else if let Ok(number) = trimmed.parse::<f64>() {
        if number.fract() != 0.0 || !number.is_finite() || number > i64::MAX as f64 {
            return Err(format!("{label} має бути цілим числом."));
        }
        number as i64
    } else {
        return Err(format!("{label} має бути цілим числом."));
    };
    if parsed < 0 {
        return Err(format!("{label} не може бути від’ємним."));
    }
    Ok(parsed)
}

fn nonnegative_count(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Ok(());
    }
    parse_integer(value, label).map(|_| ())
}

fn color_key(style: Option<usize>, section: &str, crew_status: &str) -> String {
    match style {
        Some(171) => return "crew-working".into(),
        Some(172) => return "crew-forming".into(),
        Some(173) => return "crew-inactive".into(),
        Some(174) => return "company-management".into(),
        Some(175) => return "platoon-management".into(),
        Some(176) => return "independent".into(),
        Some(177) => return "unassigned".into(),
        Some(178) => return "attached".into(),
        Some(179) => return "temporary".into(),
        _ => {}
    }
    let section_lower = section.to_lowercase();
    let status = crew_status.to_lowercase().replace(' ', "");
    if section == "Екіпаж" && status.starts_with("прац") {
        "crew-working".into()
    } else if section == "Екіпаж" && status.starts_with("форм") {
        "crew-forming".into()
    } else if section == "Екіпаж" {
        "crew-inactive".into()
    } else if section_lower.contains("управління роти") {
        "company-management".into()
    } else if section_lower.contains("управління взводу") {
        "platoon-management".into()
    } else if section == "Прикомандировані" || section == "Оперативне підпорядкування"
    {
        "attached".into()
    } else if section == "Тимчасово прибулі" {
        "temporary".into()
    } else {
        "independent".into()
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|_| "Не вдалося прочитати файл.".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn parse_file(path: &Path) -> Result<ParsedBcs, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("файл")
        .to_string();
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        return Err(format!("«{file_name}»: підтримуються лише файли .xlsx."));
    }
    let metadata = fs::metadata(path).map_err(|_| format!("«{file_name}»: файл недоступний."))?;
    if !metadata.is_file() {
        return Err(format!("«{file_name}»: обраний шлях не є файлом."));
    }
    if metadata.len() > xlsx::MAX_ARCHIVE_BYTES {
        return Err(format!("«{file_name}»: файл перевищує 25 МБ."));
    }

    let id = hash_file(path).map_err(|message| format!("«{file_name}»: {message}"))?;
    let file = File::open(path).map_err(|_| format!("«{file_name}»: не вдалося відкрити файл."))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| format!("«{file_name}»: пошкоджений або невалідний XLSX."))?;
    xlsx::validate_archive(&mut archive).map_err(|message| format!("«{file_name}»: {message}"))?;
    let sheet_rows = xlsx::read_bcs_sheet(&mut archive)
        .map_err(|message| format!("«{file_name}»: {message}"))?;

    let title = sheet_rows
        .iter()
        .find(|row| row.number == 1)
        .map(|row| cell(row, 0).value.trim().to_string())
        .unwrap_or_default();
    let date = date_from_title(&title)
        .ok_or_else(|| format!("«{file_name}»: не вдалося визначити дату з заголовка БЧС."))?;
    let unit_row = sheet_rows
        .iter()
        .find(|row| row.number == 6)
        .ok_or_else(|| format!("«{file_name}»: не вдалося визначити назву підрозділу."))?;
    let unit_cell = cell(unit_row, 0);
    let unit_name = if unit_cell.has_formula {
        let top_input = sheet_rows
            .iter()
            .find(|row| row.number == 3)
            .map(|row| cell(row, 1))
            .filter(|value| !value.has_formula)
            .ok_or_else(|| {
                format!(
                    "«{file_name}»: формула назви підрозділу дозволена лише з прямим текстом у B3."
                )
            })?;
        top_input.value.trim().to_string()
    } else {
        unit_cell.value.trim().to_string()
    };
    let unit_name = Some(unit_name)
        .filter(|value| !value.is_empty() && normalize(value) != "вкажіть назву")
        .ok_or_else(|| format!("«{file_name}»: не вдалося визначити назву підрозділу."))?;

    let schema = schema()?;
    let header = sheet_rows
        .iter()
        .find(|row| row.number == 4)
        .ok_or_else(|| format!("«{file_name}»: відсутній рядок заголовків."))?;
    for (index, expected) in schema.headers.iter().enumerate() {
        let actual = cell(header, index).value.trim();
        if normalize(actual) != normalize(expected) {
            return Err(format!(
                "«{file_name}»: колонка {} має називатися «{}», знайдено «{}».",
                index + 1,
                expected.replace('\n', " "),
                actual.replace('\n', " ")
            ));
        }
    }

    let mut carry = vec![String::new(); 10];
    let mut rows = Vec::new();
    let mut group_number = 0usize;
    for (expected_row_number, source) in
        (7usize..).zip(sheet_rows.iter().filter(|row| row.number >= 7))
    {
        if source.number != expected_row_number {
            break;
        }
        let raw_values = (0..16)
            .map(|index| cell(source, index).value.trim().to_string())
            .collect::<Vec<_>>();
        if raw_values.iter().all(String::is_empty) {
            break;
        }
        // Column F in files created by our template generator is a safe COUNTA
        // helper.  It is never evaluated here: after parsing we calculate the
        // actual crew count from the non-empty P.I.B. cells ourselves.  Every
        // other formula in the input table remains forbidden.
        if (0..16).any(|index| index != 5 && cell(source, index).has_formula) {
            return Err(format!(
                "«{file_name}»: у рядку {} основної таблиці знайдено формулу; такий файл не імпортується.",
                source.number
            ));
        }
        // Generated templates repeat column A on each physical person row so
        // summary formulas can work without hidden helper columns.  B:J still
        // mark the first row of a logical structure block.
        let starts_group = rows.is_empty()
            || raw_values[1..10].iter().any(|value| !value.is_empty())
            || (!raw_values[0].is_empty() && normalize(&raw_values[0]) != normalize(&carry[0]));
        if starts_group {
            group_number += 1;
            // Empty B:J cells on the first row of a new block are intentional.
            // Never inherit crew metadata (status, type, counts, etc.) from the
            // preceding block across this boundary.
            carry.fill(String::new());
        }
        let mut values = raw_values;
        for index in 0..10 {
            if values[index].is_empty() {
                values[index] = carry[index].clone();
            } else {
                carry[index] = values[index].clone();
            }
        }
        nonnegative_count(&values[5], "Кількість в/с, що працює в екіпажі")?;
        nonnegative_count(&values[6], "Кількість в/с за штатом")?;
        let style = source.cells.iter().find_map(|value| value.style);
        let section = values[0].clone();
        let crew_status = values[7].clone();
        let full_name = values[12].to_uppercase();
        rows.push(BcsRow {
            is_temporary: section == "Тимчасово прибулі",
            is_external: matches!(
                section.as_str(),
                "Прикомандировані" | "Оперативне підпорядкування" | "Тимчасово прибулі"
            ),
            color_key: color_key(style, &section, &crew_status),
            group_key: format!("{}:{group_number}", &id[..16]),
            section,
            position_name: values[1].to_uppercase(),
            battle_order: values[2].to_uppercase(),
            sector: values[3].to_uppercase(),
            crew_name: values[4].to_uppercase(),
            crew_actual: values[5].clone(),
            crew_official: values[6].clone(),
            crew_status,
            uav_name: values[8].clone(),
            uav_type: values[9].clone(),
            personnel_position: values[10].clone(),
            rank: values[11].clone(),
            full_name,
            duties: values[13].clone(),
            location: values[14].clone(),
            notes: values[15].clone(),
        });
    }
    if rows.is_empty() {
        return Err(format!("«{file_name}»: основна таблиця БЧС порожня."));
    }

    let authorized_row = sheet_rows
        .iter()
        .find(|row| normalize(&cell(row, 5).value) == "по штату")
        .ok_or_else(|| format!("«{file_name}»: у підсумку відсутнє значення «По штату»."))?;
    let authorized_strength =
        authorized_strength_from_rows(&sheet_rows, authorized_row, &file_name)?;

    Ok(ParsedBcs {
        id,
        path: path.to_path_buf(),
        file_name,
        unit_name,
        date,
        authorized_strength,
        rows,
    })
}

fn parse_collection(paths: &[PathBuf]) -> Result<Vec<ParsedBcs>, String> {
    if paths.len() < 2 {
        return Err("Оберіть щонайменше два файли БЧС.".into());
    }
    let mut parsed: Vec<ParsedBcs> = Vec::with_capacity(paths.len());
    let mut file_ids = HashSet::new();
    let mut units = HashSet::new();
    let mut expected_date: Option<String> = None;
    for path in paths {
        let item = parse_file(path)?;
        if !file_ids.insert(item.id.clone()) {
            return Err(format!(
                "Файл «{}» дублює вже доданий файл.",
                item.file_name
            ));
        }
        if !units.insert(normalize(&item.unit_name)) {
            return Err(format!(
                "Підрозділ «{}» трапляється у кількох файлах.",
                item.unit_name
            ));
        }
        if let Some(date) = &expected_date {
            if date != &item.date {
                return Err(format!(
                    "Не можна об’єднати БЧС за різні дати: «{}» — {}, а «{}» — {}.",
                    parsed[0].file_name, date, item.file_name, item.date
                ));
            }
        } else {
            expected_date = Some(item.date.clone());
        }
        parsed.push(item);
    }
    Ok(parsed)
}

pub fn preview_files(paths: &[PathBuf]) -> Result<ImportPreview, String> {
    let parsed = parse_collection(paths)?;
    let date = parsed[0].date.clone();
    let total_rows = parsed.iter().map(|item| item.rows.len()).sum();
    let total_personnel = parsed
        .iter()
        .flat_map(|item| &item.rows)
        .filter(|row| !row.full_name.trim().is_empty())
        .count();
    let units = parsed
        .into_iter()
        .map(|item| UnitPreview {
            id: item.id,
            path: item.path.to_string_lossy().into_owned(),
            file_name: item.file_name,
            unit_name: item.unit_name,
            date: item.date,
            row_count: item.rows.len(),
            personnel_count: item
                .rows
                .iter()
                .filter(|row| !row.full_name.trim().is_empty())
                .count(),
            authorized_strength: item.authorized_strength,
        })
        .collect();
    Ok(ImportPreview {
        date,
        total_rows,
        total_personnel,
        units,
    })
}

pub fn export_request(request: ExportRequest) -> Result<String, String> {
    let paths = request.paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    let parsed = parse_collection(&paths)?;
    if parsed.len() != request.unit_order.len() {
        return Err("Список підрозділів для експорту неповний.".into());
    }
    let mut by_id = parsed
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::with_capacity(request.unit_order.len());
    for id in &request.unit_order {
        let item = by_id.remove(id).ok_or_else(|| {
            "Порядок підрозділів містить невідомий або повторений файл.".to_string()
        })?;
        ordered.push(item);
    }
    if !by_id.is_empty() {
        return Err("Порядок підрозділів не містить усіх файлів.".into());
    }

    let output = PathBuf::from(&request.output_path);
    if output
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        return Err("Файл зведення повинен мати розширення .xlsx.".into());
    }
    if paths.iter().any(|input| input == &output) {
        return Err("Не можна перезаписати один із вхідних файлів.".into());
    }
    export_workbook(&output, &ordered)?;
    Ok(output.to_string_lossy().into_owned())
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn column(index: usize) -> char {
    (b'A' + index as u8) as char
}

fn text_cell(column_index: usize, row: usize, value: &str, style: usize) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
        column(column_index),
        esc(value)
    )
}

fn number_cell(column_index: usize, row: usize, value: i64, style: usize) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\"><v>{value}</v></c>",
        column(column_index)
    )
}

fn bcs_styles() -> String {
    let fills = [
        "D7E48D", "FDEADA", "E6B8B7", "CCC0DA", "C7BED0", "DBEEF4", "D7E4BD", "F2DCDB",
        "FCD5B4",
    ]
    .iter()
    .map(|color| format!("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF{color}\"/><bgColor indexed=\"64\"/></patternFill></fill>"))
    .collect::<String>();
    let formats = (10..=18)
        .map(|fill| format!("<xf numFmtId=\"0\" fontId=\"7\" fillId=\"{fill}\" borderId=\"7\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"center\" wrapText=\"1\"/></xf>"))
        .collect::<String>();
    include_str!("../resources/bcs-reference-styles.xml")
        .replace("<fills count=\"10\">", "<fills count=\"19\">")
        .replace("</fills>", &format!("{fills}</fills>"))
        .replace("<cellXfs count=\"171\">", "<cellXfs count=\"180\">")
        .replace("</cellXfs>", &format!("{formats}</cellXfs>"))
}

fn style_for(row: &BcsRow) -> usize {
    match row.color_key.as_str() {
        "crew-working" => 171,
        "crew-forming" => 172,
        "crew-inactive" => 173,
        "company-management" => 174,
        "platoon-management" => 175,
        "independent" => 176,
        "unassigned" => 177,
        "attached" => 178,
        "temporary" => 179,
        _ => 177,
    }
}

fn row_height(row: &BcsRow, widths: &[f64]) -> usize {
    let values = row.values();
    let max_lines = values
        .iter()
        .enumerate()
        .skip(10)
        .map(|(index, value)| {
            value
                .split('\n')
                .map(|line| {
                    (line.chars().count() as f64 / (widths[index] * 0.8))
                        .ceil()
                        .max(1.0) as usize
                })
                .sum::<usize>()
        })
        .max()
        .unwrap_or(1);
    (max_lines * 14 + 10).max(40)
}

fn write_unit_rows(
    sheet: &mut String,
    merges: &mut Vec<String>,
    unit: &ParsedBcs,
    cursor: &mut usize,
    widths: &[f64],
) -> Result<(), String> {
    sheet.push_str(&format!(
        "<row r=\"{}\" ht=\"20\" customHeight=\"1\">{}</row>",
        *cursor,
        text_cell(0, *cursor, &unit.unit_name, 6)
    ));
    merges.push(format!("A{}:P{}", *cursor, *cursor));
    *cursor += 1;

    let mut start = 0usize;
    while start < unit.rows.len() {
        let mut end = start + 1;
        while end < unit.rows.len() && unit.rows[end].group_key == unit.rows[start].group_key {
            end += 1;
        }
        if end - start > 1 {
            for index in 0..10 {
                merges.push(format!(
                    "{}{}:{}{}",
                    column(index),
                    *cursor,
                    column(index),
                    *cursor + end - start - 1
                ));
            }
        }
        for (offset, row) in unit.rows[start..end].iter().enumerate() {
            let current = *cursor + offset;
            sheet.push_str(&format!(
                "<row r=\"{current}\" ht=\"{}\" customHeight=\"1\">",
                row_height(row, widths)
            ));
            let values = row.values();
            let style = style_for(row);
            for (index, value) in values.iter().enumerate() {
                let value = if offset > 0 && index < 10 { "" } else { value };
                if (index == 5 || index == 6) && !value.trim().is_empty() {
                    let count = parse_integer(value, "Кількість в/с")?;
                    sheet.push_str(&number_cell(index, current, count, style));
                } else {
                    sheet.push_str(&text_cell(index, current, value, style));
                }
            }
            sheet.push_str("</row>");
        }
        *cursor += end - start;
        start = end;
    }
    Ok(())
}

fn export_workbook(path: &Path, units: &[ParsedBcs]) -> Result<(), String> {
    let schema = schema()?;
    let date = &units[0].date;
    let mut merges = vec!["A1:O2".to_string()];
    let mut sheet = String::from("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"6\" topLeftCell=\"A7\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols>");
    for (index, width) in schema.widths.iter().enumerate() {
        sheet.push_str(&format!(
            "<col min=\"{}\" max=\"{}\" width=\"{width}\" customWidth=\"1\"/>",
            index + 1,
            index + 1
        ));
    }
    sheet.push_str("</cols><sheetData><row r=\"1\" ht=\"18\" customHeight=\"1\">");
    sheet.push_str(&text_cell(
        0,
        1,
        &format!("ЗВЕДЕНИЙ БЧС\nстаном на 08:00 год {date} року"),
        2,
    ));
    sheet.push_str("</row><row r=\"2\" ht=\"44.25\" customHeight=\"1\"/><row r=\"4\" ht=\"30\" customHeight=\"1\">");
    for (index, header) in schema.headers.iter().enumerate() {
        sheet.push_str(&text_cell(index, 4, header, 3));
        merges.push(format!("{}4:{}5", column(index), column(index)));
    }
    sheet.push_str("</row><row r=\"5\" ht=\"30\" customHeight=\"1\">");
    for index in 0..schema.headers.len() {
        sheet.push_str(&text_cell(index, 5, "", 3));
    }
    sheet.push_str("</row>");

    let mut cursor = 6usize;
    for unit in units {
        write_unit_rows(&mut sheet, &mut merges, unit, &mut cursor, &schema.widths)?;
    }
    let summary = cursor + 2;
    write_summary(&mut sheet, summary, units, &schema.locations)?;
    sheet.push_str(&format!(
        "</sheetData><mergeCells count=\"{}\">{}</mergeCells><pageMargins left=\"0.25\" right=\"0.25\" top=\"0.3\" bottom=\"0.3\" header=\"0\" footer=\"0\"/><pageSetup paperSize=\"8\" orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>",
        merges.len(),
        merges
            .iter()
            .map(|range| format!("<mergeCell ref=\"{range}\"/>"))
            .collect::<String>()
    ));

    xlsx::write_styled_workbook(
        path,
        "БЧС",
        &sheet,
        &bcs_styles(),
        include_str!("../resources/bcs-reference-theme.xml"),
    )
}

fn write_summary(
    sheet: &mut String,
    summary: usize,
    units: &[ParsedBcs],
    locations: &[String],
) -> Result<(), String> {
    let rows = units.iter().flat_map(|unit| &unit.rows).collect::<Vec<_>>();
    let personnel = rows
        .iter()
        .copied()
        .filter(|row| !row.full_name.trim().is_empty())
        .collect::<Vec<_>>();
    let absent = [
        "ВІДП",
        "ЛІК",
        "ВЛК",
        "НАВЧ",
        "ВІДР",
        "Відкомандировані",
        "СЗЧ",
        "ПТЗ Новостав",
    ];
    let own = personnel.iter().filter(|row| !row.is_external).count() as i64;
    let count_own_location = |location: &str| {
        personnel
            .iter()
            .filter(|row| !row.is_external && row.location == location)
            .count() as i64
    };
    let count_all_location = |location: &str| {
        personnel
            .iter()
            .filter(|row| row.location == location)
            .count() as i64
    };
    let temporary_acting = personnel
        .iter()
        .filter(|row| row.is_temporary && row.personnel_position.to_uppercase().contains("ТВО"))
        .count() as i64;
    let present = personnel
        .iter()
        .filter(|row| !row.is_external && !absent.contains(&row.location.as_str()))
        .count() as i64;
    let authorized = units.iter().try_fold(0i64, |total, unit| {
        total
            .checked_add(unit.authorized_strength)
            .ok_or_else(|| "Сума штатної чисельності завелика.".to_string())
    })?;
    let labels = [
        "По штату",
        "По списку",
        "В наявності",
        "Відпустка",
        "Шпиталь",
        "Відрядження",
        "Відкомандировані",
        "Прикомандировані",
        "Оперативне підпорядкування",
        "ПТЗ Новостав",
        "СЗЧ",
        "Тимчасово прибулі",
        "Тимчасово прибулі з ТВО",
    ];
    let values = [
        authorized,
        own + temporary_acting,
        present,
        count_own_location("ВІДП"),
        count_own_location("ЛІК") + count_own_location("ВЛК"),
        count_own_location("НАВЧ") + count_own_location("ВІДР"),
        count_own_location("Відкомандировані"),
        personnel
            .iter()
            .filter(|row| row.section == "Прикомандировані")
            .count() as i64,
        personnel
            .iter()
            .filter(|row| row.section == "Оперативне підпорядкування")
            .count() as i64,
        count_own_location("ПТЗ Новостав"),
        count_own_location("СЗЧ"),
        personnel.iter().filter(|row| row.is_temporary).count() as i64,
        temporary_acting,
    ];

    let mut group_starts = Vec::new();
    for unit in units {
        let mut previous = "";
        for row in &unit.rows {
            if row.group_key != previous {
                group_starts.push(row);
                previous = &row.group_key;
            }
        }
    }
    let crews = group_starts
        .iter()
        .copied()
        .filter(|row| row.section == "Екіпаж" && !row.crew_name.is_empty())
        .collect::<Vec<_>>();
    let crew_personnel = personnel
        .iter()
        .filter(|row| row.section == "Екіпаж")
        .map(|row| row.full_name.to_uppercase())
        .collect::<HashSet<_>>()
        .len() as i64;
    let mut functional = vec![
        ("Екіпажів (ос-загально)".to_string(), crew_personnel),
        ("Екіпажів (загально)".to_string(), crews.len() as i64),
    ];
    let mut crew_types = BTreeMap::<String, i64>::new();
    for crew in &crews {
        if !crew.uav_type.trim().is_empty() {
            *crew_types
                .entry(crew.uav_type.trim().to_string())
                .or_default() += 1;
        }
    }
    functional.extend(
        crew_types
            .into_iter()
            .map(|(kind, count)| (format!("Екіпажів — {kind}"), count)),
    );
    let status_group = |status: &str| {
        let normalized = status.to_lowercase().replace(' ', "");
        if normalized.starts_with("форм") {
            "forming"
        } else if normalized.starts_with("прац") || normalized == "активний" {
            "working"
        } else {
            "inactive"
        }
    };
    for (label, group) in [
        ("Екіпажів — Формуються", "forming"),
        ("Екіпажів — Працюючі", "working"),
        ("Екіпажів — Не активні", "inactive"),
    ] {
        functional.push((
            label.into(),
            crews
                .iter()
                .filter(|row| status_group(&row.crew_status) == group)
                .count() as i64,
        ));
    }
    let mut sections = Vec::<String>::new();
    for row in &rows {
        if !row.is_external
            && !row.section.is_empty()
            && row.section != "Екіпаж"
            && !sections.contains(&row.section)
        {
            sections.push(row.section.clone());
        }
    }
    for section in sections {
        functional.push((
            section.clone(),
            personnel
                .iter()
                .filter(|row| {
                    row.section == section
                        && !absent.contains(&row.location.as_str())
                        && row.location != "ПТЗ Новостав"
                })
                .count() as i64,
        ));
    }

    sheet.push_str(&format!(
        "<row r=\"{summary}\">{}{}{}</row>",
        text_cell(5, summary, "ЗВЕДЕНИЙ БЧС:", 5),
        text_cell(8, summary, "БЧС по функціоналу:", 5),
        text_cell(11, summary, "Де знаходиться", 5)
    ));
    let row_count = (locations.len() + 2)
        .max(functional.len())
        .max(labels.len());
    for index in 0..row_count {
        let row_number = summary + index + 1;
        sheet.push_str(&format!(
            "<row r=\"{row_number}\" ht=\"24\" customHeight=\"1\">"
        ));
        if let (Some(label), Some(value)) = (labels.get(index), values.get(index)) {
            sheet.push_str(&text_cell(5, row_number, label, 3));
            sheet.push_str(&number_cell(6, row_number, *value, 3));
        }
        if let Some((label, value)) = functional.get(index) {
            sheet.push_str(&text_cell(8, row_number, label, 3));
            sheet.push_str(&number_cell(9, row_number, *value, 3));
        }
        if let Some(location) = locations.get(index) {
            sheet.push_str(&text_cell(11, row_number, location, 3));
            sheet.push_str(&number_cell(
                12,
                row_number,
                count_all_location(location),
                3,
            ));
        } else if index == locations.len() {
            let unknown = personnel
                .iter()
                .filter(|row| !locations.contains(&row.location))
                .count() as i64;
            sheet.push_str(&text_cell(11, row_number, "Не вказано / інше", 3));
            sheet.push_str(&number_cell(12, row_number, unknown, 3));
        } else if index == locations.len() + 1 {
            sheet.push_str(&text_cell(11, row_number, "Загалом", 3));
            sheet.push_str(&number_cell(12, row_number, personnel.len() as i64, 3));
        }
        sheet.push_str("</row>");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_unit(path: &Path, unit: &str, date: &str, authorized: i64) -> ParsedBcs {
        ParsedBcs {
            id: format!("id-{unit}"),
            path: path.to_path_buf(),
            file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
            unit_name: unit.into(),
            date: date.into(),
            authorized_strength: authorized,
            rows: vec![BcsRow {
                color_key: "crew-working".into(),
                group_key: format!("group-{unit}"),
                section: "Екіпаж".into(),
                position_name: "позиція-тест".into(),
                battle_order: "бро-тест".into(),
                sector: "сектор-тест".into(),
                crew_name: "екіпаж-тест".into(),
                crew_actual: "4".into(),
                crew_official: "1".into(),
                crew_status: "Працюючий".into(),
                uav_name: "БпАК-ТЕСТ".into(),
                uav_type: "Коптер".into(),
                personnel_position: "тестова посада".into(),
                rank: "солдат".into(),
                full_name: "Особа-001".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            }],
        }
    }

    fn summary_value(xml: &str, label: &str) -> i64 {
        let label_at = xml
            .find(label)
            .unwrap_or_else(|| panic!("missing label: {label}"));
        let after_label = &xml[label_at + label.len()..];
        let value_start = after_label.find("<v>").unwrap() + 3;
        let value_end = after_label[value_start..].find("</v>").unwrap() + value_start;
        after_label[value_start..value_end].parse().unwrap()
    }

    #[test]
    fn summary_follows_external_presence_location_and_unique_crew_rules() {
        let path = PathBuf::from("logic.xlsx");
        let mut unit = sample_unit(&path, "ТЕСТ", "08.10.2026", 3);
        unit.rows = vec![
            BcsRow {
                group_key: "crew-1".into(),
                section: "Екіпаж".into(),
                crew_name: "АЛЬФА".into(),
                crew_status: "Працюючий".into(),
                full_name: "ОСОБА-1".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                group_key: "crew-2".into(),
                section: "Екіпаж".into(),
                crew_name: "БЕТА".into(),
                crew_status: "Формується".into(),
                full_name: "ОСОБА-1".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                group_key: "management".into(),
                section: "Управління роти".into(),
                full_name: "ОСОБА-2".into(),
                location: "ВІДП".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_external: true,
                group_key: "attached".into(),
                section: "Прикомандировані".into(),
                full_name: "ОСОБА-3".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_external: true,
                group_key: "operational".into(),
                section: "Оперативне підпорядкування".into(),
                full_name: "ОСОБА-4".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_temporary: true,
                is_external: true,
                group_key: "temporary-1".into(),
                section: "Тимчасово прибулі".into(),
                personnel_position: "ТВО ОПЕРАТОР".into(),
                full_name: "ОСОБА-5".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_temporary: true,
                is_external: true,
                group_key: "temporary-2".into(),
                section: "Тимчасово прибулі".into(),
                personnel_position: "ОПЕРАТОР".into(),
                full_name: "ОСОБА-6".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
        ];

        let mut xml = String::new();
        write_summary(&mut xml, 100, &[unit], &["ПУ".into(), "ВІДП".into()]).unwrap();

        assert_eq!(summary_value(&xml, "По списку"), 4);
        assert_eq!(summary_value(&xml, "В наявності"), 2);
        assert_eq!(summary_value(&xml, "Прикомандировані"), 1);
        assert_eq!(summary_value(&xml, "Оперативне підпорядкування"), 1);
        assert_eq!(summary_value(&xml, "Тимчасово прибулі з ТВО"), 1);
        assert_eq!(summary_value(&xml, "Екіпажів (ос-загально)"), 1);
        assert_eq!(summary_value(&xml, "Управління роти"), 0);
        assert_eq!(summary_value(&xml, "ПУ"), 6);
        assert_eq!(summary_value(&xml, "Загалом"), 7);
    }

    #[test]
    fn imports_an_anonymized_raportgen_shaped_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unit-a.xlsx");
        let unit = sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ А", "08.10.2026", 10);
        export_workbook(&path, &[unit]).unwrap();
        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed.unit_name, "ТЕСТОВИЙ ПІДРОЗДІЛ А");
        assert_eq!(parsed.date, "08.10.2026");
        assert_eq!(parsed.authorized_strength, 10);
        assert_eq!(parsed.rows[0].position_name, "ПОЗИЦІЯ-ТЕСТ");
        assert_eq!(parsed.rows[0].battle_order, "БРО-ТЕСТ");
        assert_eq!(parsed.rows[0].sector, "СЕКТОР-ТЕСТ");
        assert_eq!(parsed.rows[0].crew_name, "ЕКІПАЖ-ТЕСТ");
        assert_eq!(parsed.rows[0].crew_actual, "4");
        assert_eq!(parsed.rows[0].crew_official, "1");
        assert_eq!(parsed.rows[0].full_name, "ОСОБА-001");
    }

    #[test]
    fn does_not_carry_crew_metadata_into_the_next_management_block() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("crew-then-management.xlsx");
        let mut unit = sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ", "08.10.2026", 2);
        unit.rows.push(BcsRow {
            color_key: "company-management".into(),
            group_key: "management-group".into(),
            section: "Управління роти".into(),
            position_name: "Управління".into(),
            crew_official: "1".into(),
            personnel_position: "тестова посада".into(),
            full_name: "ОСОБА-002".into(),
            location: "ПУ".into(),
            ..BcsRow::default()
        });
        export_workbook(&path, &[unit]).unwrap();

        let parsed = parse_file(&path).unwrap();
        let management = parsed
            .rows
            .iter()
            .find(|row| row.section == "Управління роти")
            .unwrap();
        assert_eq!(management.position_name, "УПРАВЛІННЯ");
        assert!(management.crew_name.is_empty());
        assert!(management.crew_actual.is_empty());
        assert!(management.crew_status.is_empty());
        assert!(management.uav_type.is_empty());
    }

    #[test]
    fn reads_authorized_strength_from_h3_without_executing_summary_formula() {
        let mut top_cells = vec![Cell::default(); 8];
        top_cells[7] = Cell {
            value: "30".into(),
            style: None,
            has_formula: false,
        };
        let mut summary_cells = vec![Cell::default(); 7];
        summary_cells[6] = Cell {
            value: "0".into(),
            style: None,
            has_formula: true,
        };
        let rows = vec![
            SheetRow {
                number: 3,
                cells: top_cells,
            },
            SheetRow {
                number: 510,
                cells: summary_cells,
            },
        ];

        let value = authorized_strength_from_rows(&rows, &rows[1], "template.xlsx").unwrap();
        assert_eq!(value, 30);
    }

    #[test]
    fn rejects_different_dates() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("unit-a.xlsx");
        let second_path = directory.path().join("unit-b.xlsx");
        export_workbook(
            &first_path,
            &[sample_unit(
                &first_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ А",
                "08.10.2026",
                10,
            )],
        )
        .unwrap();
        export_workbook(
            &second_path,
            &[sample_unit(
                &second_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ Б",
                "09.10.2026",
                12,
            )],
        )
        .unwrap();
        let error = parse_collection(&[first_path, second_path]).unwrap_err();
        assert!(error.contains("різні дати"));
    }

    #[test]
    fn rejects_duplicate_files_and_duplicate_units() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("unit-a.xlsx");
        let second_path = directory.path().join("unit-a-copy.xlsx");
        export_workbook(
            &first_path,
            &[sample_unit(
                &first_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ А",
                "08.10.2026",
                10,
            )],
        )
        .unwrap();
        let duplicate_file_error =
            parse_collection(&[first_path.clone(), first_path.clone()]).unwrap_err();
        assert!(duplicate_file_error.contains("дублює"));

        export_workbook(
            &second_path,
            &[sample_unit(
                &second_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ А",
                "08.10.2026",
                11,
            )],
        )
        .unwrap();
        let duplicate_unit_error = parse_collection(&[first_path, second_path]).unwrap_err();
        assert!(duplicate_unit_error.contains("трапляється у кількох файлах"));
    }

    #[test]
    fn rejects_a_corrupted_workbook() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("broken.xlsx");
        std::fs::write(&path, b"not an xlsx archive").unwrap();
        let error = parse_file(&path).unwrap_err();
        assert!(error.contains("пошкоджений або невалідний XLSX"));
    }

    #[test]
    fn exports_units_in_requested_order_with_one_recalculated_summary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("summary.xlsx");
        let units = [
            sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ Б", "08.10.2026", 12),
            sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ А", "08.10.2026", 10),
        ];
        export_workbook(&path, &units).unwrap();
        let file = File::open(&path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut xml = String::new();
        use std::io::Read;
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        let first = xml.find("ТЕСТОВИЙ ПІДРОЗДІЛ Б").unwrap();
        let second = xml.find("ТЕСТОВИЙ ПІДРОЗДІЛ А").unwrap();
        assert!(first < second);
        assert_eq!(xml.matches("ЗВЕДЕНИЙ БЧС:").count(), 1);
        assert!(xml.contains(">22</v>"));
        assert!(!xml.contains("<f>"));
    }
}
