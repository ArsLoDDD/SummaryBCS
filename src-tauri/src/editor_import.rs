use crate::xlsx::{self, Cell, SheetRow};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::Read,
    path::Path,
};
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEditorWorkspace {
    version: u8,
    unit_name: String,
    report_date: String,
    structure_type: String,
    authorized_strength: u32,
    blocks: Vec<ImportedBlock>,
    people_by_slot: BTreeMap<String, ImportedPerson>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedBlock {
    id: String,
    kind: String,
    name: String,
    position_name: String,
    slots: u32,
    status: String,
    uav_type: String,
    bro: String,
    work_sector: String,
    uav_name: String,
    crew_actual: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ImportedPerson {
    block_id: String,
    position: String,
    rank: String,
    full_name: String,
    duties: String,
    location: String,
    note: String,
}

#[derive(Debug, Clone, Copy)]
struct MergeRange {
    first_column: usize,
    last_column: usize,
    first_row: usize,
    last_row: usize,
}

#[derive(serde::Deserialize)]
struct Schema {
    headers: Vec<String>,
    locations: Vec<String>,
}

const CREW_STATUSES: [&str; 3] = ["Працюючий", "Формується", "Не активний"];
const UAV_TYPES: [&str; 7] = [
    "ФПВ",
    "ФПВ Перехоплювач",
    "Коптер",
    "Бомбер",
    "Літаковий Розвідувальний",
    "Літаковий Ударний",
    "НРК",
];

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn header_key(value: &str) -> String {
    value
        .chars()
        .filter(|value| value.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn cell(row: &SheetRow, column: usize) -> &Cell {
    static EMPTY: std::sync::OnceLock<Cell> = std::sync::OnceLock::new();
    row.cells
        .get(column)
        .unwrap_or_else(|| EMPTY.get_or_init(Cell::default))
}

fn value(row: &SheetRow, column: usize) -> String {
    cell(row, column).value.trim().to_string()
}

fn metadata_cell<'a>(
    rows: &'a [SheetRow],
    merges: &[MergeRange],
    row: &'a SheetRow,
    column: usize,
) -> &'a Cell {
    let stored = cell(row, column);
    if !stored.value.is_empty() || stored.has_formula {
        return stored;
    }
    merges
        .iter()
        .find(|merge| {
            merge.first_column == column
                && merge.last_column == column
                && merge.first_row < row.number
                && merge.last_row >= row.number
        })
        .and_then(|merge| rows.iter().find(|source| source.number == merge.first_row))
        .map_or(stored, |source| cell(source, column))
}

fn metadata_value(
    rows: &[SheetRow],
    merges: &[MergeRange],
    row: &SheetRow,
    column: usize,
) -> String {
    metadata_cell(rows, merges, row, column)
        .value
        .trim()
        .to_string()
}

fn xml_attribute(fragment: &str, name: &str) -> Option<String> {
    fragment
        .split_once(&format!("{name}=\""))?
        .1
        .split_once('"')
        .map(|(value, _)| {
            value
                .replace("&quot;", "\"")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
        })
}

fn archive_text(archive: &mut ZipArchive<File>, name: &str) -> Result<String, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("XLSX не містить «{name}»."))?;
    if entry.size() > 20 * 1024 * 1024 {
        return Err("Внутрішній файл XLSX завеликий.".into());
    }
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|_| "Не вдалося прочитати XML у XLSX.".to_string())?;
    Ok(text.replace("<x:", "<").replace("</x:", "</"))
}

fn coordinate(value: &str) -> Option<(usize, usize)> {
    let letters = value
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>();
    if letters.is_empty() {
        return None;
    }
    let column = letters.bytes().try_fold(0usize, |acc, letter| {
        acc.checked_mul(26)?
            .checked_add((letter.to_ascii_uppercase() - b'A' + 1) as usize)
    })?;
    let row = value.get(letters.len()..)?.parse::<usize>().ok()?;
    (row > 0).then_some((column - 1, row))
}

fn parse_merges(xml: &str) -> Vec<MergeRange> {
    xml.split("<mergeCell ")
        .skip(1)
        .filter_map(|raw| {
            let reference = xml_attribute(raw.split_once('>')?.0, "ref")?;
            let (first, last) = reference.split_once(':')?;
            let (first_column, first_row) = coordinate(first)?;
            let (last_column, last_row) = coordinate(last)?;
            (first_row <= last_row && first_column <= last_column).then_some(MergeRange {
                first_column,
                last_column,
                first_row,
                last_row,
            })
        })
        .collect()
}

fn read_merges(archive: &mut ZipArchive<File>) -> Result<Vec<MergeRange>, String> {
    let workbook = archive_text(archive, "xl/workbook.xml")?;
    let relationship_id = workbook
        .split("<sheet ")
        .skip(1)
        .filter_map(|item| item.split_once('>').map(|(opening, _)| opening))
        .find(|item| xml_attribute(item, "name").as_deref() == Some("БЧС"))
        .and_then(|item| xml_attribute(item, "r:id"))
        .ok_or_else(|| "Відсутній аркуш «БЧС».".to_string())?;
    let relationships = archive_text(archive, "xl/_rels/workbook.xml.rels")?;
    let relationship = relationships
        .split("<Relationship ")
        .skip(1)
        .filter_map(|item| item.split_once('>').map(|(opening, _)| opening))
        .find(|item| xml_attribute(item, "Id").as_deref() == Some(relationship_id.as_str()))
        .ok_or_else(|| "Відсутній внутрішній зв’язок аркуша БЧС.".to_string())?;
    if xml_attribute(relationship, "TargetMode").as_deref() == Some("External") {
        return Err("Зовнішні аркуші не підтримуються.".into());
    }
    let target = xml_attribute(relationship, "Target")
        .ok_or_else(|| "Не знайдено шлях аркуша БЧС.".to_string())?;
    let target = target.trim_start_matches('/');
    let path = if target.starts_with("xl/") {
        target.to_string()
    } else {
        format!("xl/{target}")
    };
    if !path.starts_with("xl/worksheets/") || path.contains("..") || path.contains('\\') {
        return Err("Некоректний внутрішній шлях аркуша XLSX.".into());
    }
    Ok(parse_merges(&archive_text(archive, &path)?))
}

fn parsed_count(raw: &str) -> Option<u32> {
    let number = raw.trim().parse::<f64>().ok()?;
    (number.is_finite() && (0.0..=20_000.0).contains(&number) && number.fract() == 0.0)
        .then_some(number as u32)
}

fn title_date(title: &str) -> Option<String> {
    for token in title.split(|character: char| !(character.is_ascii_digit() || character == '.')) {
        let parts = token.trim_matches('.').split('.').collect::<Vec<_>>();
        if parts.len() != 3 || parts[0].len() != 2 || parts[1].len() != 2 || parts[2].len() != 4 {
            continue;
        }
        let (Some(day), Some(month), Some(year)) = (
            parts[0].parse::<u32>().ok(),
            parts[1].parse::<u32>().ok(),
            parts[2].parse::<u32>().ok(),
        ) else {
            continue;
        };
        if !(2000..=9999).contains(&year) || !(1..=12).contains(&month) {
            continue;
        }
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let days = match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if (1..=days).contains(&day) {
            return Some(format!("{year:04}-{month:02}-{day:02}"));
        }
    }
    None
}

fn canonical(raw: &str, allowed: &[&str]) -> String {
    allowed
        .iter()
        .find(|allowed| normalized(allowed) == normalized(raw))
        .map_or_else(|| raw.trim().to_string(), |allowed| (*allowed).to_string())
}

fn block_kind(section: &str, is_crew: bool) -> &'static str {
    let section = normalized(section);
    if is_crew || section == "екіпаж" {
        "crew"
    } else if section.contains("управління рот") {
        "companyManagement"
    } else if section.contains("управління взвод") {
        "platoonManagement"
    } else if section.contains("збору") && section.contains("інформац") {
        "informationDepartment"
    } else if section.starts_with("відділення") {
        "department"
    } else if section == "прикомандировані" {
        "attached"
    } else if section == "оперативне підпорядкування" {
        "operationalSubordination"
    } else if section.contains("тимчас") && section.contains("тво") {
        "temporaryActing"
    } else if section.contains("тимчасово прибул") {
        "temporary"
    } else if section == "не розподілені" {
        "unassigned"
    } else if section.is_empty() || section == "інші" || section == "інші підрозділи"
    {
        "custom"
    } else {
        "independent"
    }
}

fn person_from_row(row: &SheetRow, block_id: &str) -> ImportedPerson {
    ImportedPerson {
        block_id: block_id.to_string(),
        position: value(row, 10),
        rank: value(row, 11),
        full_name: value(row, 12),
        duties: value(row, 13),
        location: value(row, 14),
        note: value(row, 15),
    }
}

fn singleton(kind: &str) -> bool {
    matches!(kind, "companyManagement" | "platoonManagement" | "custom")
}

fn push_warning(warnings: &mut Vec<String>, text: String) {
    if !warnings.contains(&text) {
        warnings.push(text);
    }
}

pub fn import_bcs_editor(path: String) -> Result<ImportedEditorWorkspace, String> {
    let path = Path::new(&path);
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
    {
        return Err("Для редактора оберіть файл БЧС з розширенням .xlsx.".into());
    }
    let metadata = path
        .metadata()
        .map_err(|_| "Не вдалося відкрити обраний файл БЧС.".to_string())?;
    if !metadata.is_file() || metadata.len() > xlsx::MAX_ARCHIVE_BYTES {
        return Err("Файл БЧС недоступний або перевищує 25 МБ.".into());
    }
    let file = File::open(path).map_err(|_| "Не вдалося прочитати файл БЧС.".to_string())?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "Файл не є коректним XLSX або пошкоджений.".to_string())?;
    xlsx::validate_archive(&mut archive)?;
    let rows = xlsx::read_bcs_sheet(&mut archive)?;
    let merges = read_merges(&mut archive)?;
    parse_workspace(&rows, &merges)
}

fn parse_workspace(
    rows: &[SheetRow],
    merges: &[MergeRange],
) -> Result<ImportedEditorWorkspace, String> {
    let schema: Schema = serde_json::from_str(include_str!("../../src/shared/bcs-schema.json"))
        .map_err(|_| "Вбудована схема БЧС пошкоджена.".to_string())?;
    let semantic_kinds = rows
        .iter()
        .find(|row| row.number == 4)
        .is_some_and(|row| value(row, 19) == "__BCS_KIND_V1");
    let header = rows.iter().find(|row| schema.headers.iter().enumerate().all(|(column, expected)| header_key(&cell(row, column).value) == header_key(expected)))
        .ok_or_else(|| "Не розпізнано таблицю БЧС. Потрібні всі 16 колонок стандартного БЧС у початковому порядку.".to_string())?;
    let title = rows
        .iter()
        .filter(|row| row.number < header.number)
        .flat_map(|row| &row.cells)
        .map(|cell| cell.value.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if normalized(&title).starts_with("зведений бчс") {
        return Err("Зведений БЧС містить декілька підрозділів. Для редактора імпортуйте БЧС одного підрозділу.".into());
    }
    let report_date = title_date(&title).ok_or_else(|| {
        "Не вдалося визначити дату у заголовку БЧС (очікується ДД.ММ.РРРР).".to_string()
    })?;
    let summary_start = rows
        .iter()
        .find(|row| {
            row.number > header.number
                && (0..4).all(|column| value(row, column).is_empty())
                && [4, 5]
                    .iter()
                    .any(|column| normalized(&value(row, *column)).starts_with("бчс"))
                && matches!(
                    normalized(&value(row, 8)).as_str(),
                    "бчс по функціоналу:" | "бчс по функціоналу"
                )
                && normalized(&value(row, 11)) == "де знаходиться"
                && [10, 12, 13, 14, 15]
                    .iter()
                    .all(|column| value(row, *column).is_empty())
                && (!semantic_kinds || value(row, 19).is_empty())
        })
        .map_or(usize::MAX, |row| row.number);
    let candidate_rows = rows
        .iter()
        .filter(|row| row.number > header.number && row.number < summary_start)
        .collect::<Vec<_>>();
    let banner_rows = candidate_rows
        .iter()
        .copied()
        .filter(|row| {
            !value(row, 0).is_empty()
                && (1..16).all(|column| value(row, column).is_empty())
                && merges.iter().any(|merge| {
                    merge.first_column == 0
                        && merge.last_column >= 14
                        && merge.first_row == row.number
                        && merge.last_row == row.number
                })
        })
        .collect::<Vec<_>>();
    if banner_rows.len() > 1 {
        return Err(
            "Файл містить декілька блоків підрозділів. Імпортуйте окремий БЧС одного підрозділу."
                .into(),
        );
    }
    let banner = banner_rows
        .first()
        .ok_or_else(|| "Не знайдено рядок з назвою підрозділу над особовим складом.".to_string())?;
    if cell(banner, 0).has_formula {
        return Err(
            "Назва підрозділу задана формулою. Збережіть у цьому полі звичайний текст.".into(),
        );
    }
    let unit_name = value(banner, 0);
    if unit_name.len() > 800 {
        return Err("Назва підрозділу перевищує допустиму довжину.".into());
    }
    let data_rows = candidate_rows
        .into_iter()
        .filter(|row| row.number > banner.number)
        .collect::<Vec<_>>();
    if data_rows.iter().any(|row| row.number > 30_000) {
        return Err("Таблиця БЧС містить забагато рядків.".into());
    }
    let mut warnings = Vec::new();
    let authorized_strength = rows.iter().filter(|row| row.number >= summary_start).flat_map(|row| row.cells.iter().enumerate().map(move |(column, cell)| (row, column, cell)))
        .find(|(_, _, cell)| normalized(&cell.value) == "по штату")
        .and_then(|(row, column, _)| {
            let count = cell(row, column + 1);
            if count.has_formula {
                push_warning(&mut warnings, "«По штату» прочитано зі збереженого значення формули; формули під час імпорту не виконуються.".into());
            }
            parsed_count(&count.value).filter(|count| *count > 0)
        }).unwrap_or_else(|| {
            push_warning(&mut warnings, "Не знайдено коректної чисельності «По штату». Вкажіть її в параметрах підрозділу.".into());
            0
        });

    let mut groups: Vec<Vec<&SheetRow>> = Vec::new();
    let mut current_end = 0usize;
    for row in data_rows {
        let has_person = (10..16).any(|column| !value(row, column).is_empty());
        let has_block = (0..10).any(|column| !value(row, column).is_empty());
        let merged_group = merges.iter().find(|merge| {
            merge.first_column == 0 && merge.last_column == 0 && merge.first_row == row.number
        });
        let merged_crew = merges.iter().find(|merge| {
            merge.first_column == 4
                && merge.last_column == 4
                && merge.first_row == row.number
                && !value(row, 4).is_empty()
        });
        let changed_identity = groups.last().is_some_and(|group| {
            let previous = group[0];
            (!value(row, 4).is_empty()
                && value(row, 4) != metadata_value(rows, merges, previous, 4))
                || (!value(row, 0).is_empty()
                    && normalized(&value(row, 0))
                        != normalized(&metadata_value(rows, merges, previous, 0)))
        });
        let start = merged_crew.is_some()
            || merged_group.is_some()
            || changed_identity
            || (has_block && (groups.is_empty() || row.number > current_end));
        if start {
            let declared_end = parsed_count(&value(row, 6))
                .filter(|count| *count > 0 && *count <= 2_000)
                .map_or(row.number, |count| row.number + count as usize - 1);
            current_end = merged_crew
                .or(merged_group)
                .map_or(declared_end, |merge| merge.last_row);
            groups.push(vec![row]);
        } else if let Some(group) = groups.last_mut() {
            if row.number <= current_end || has_person {
                group.push(row);
            }
        } else if has_person {
            return Err(format!(
                "Рядок {}: дані людини не належать жодному структурному блоку.",
                row.number
            ));
        }
    }
    if groups.is_empty() {
        return Err("У файлі не знайдено структурних блоків особового складу.".into());
    }
    if groups.len() > 2_000 {
        return Err("У БЧС забагато структурних блоків (максимум 2 000).".into());
    }
    let mut blocks: Vec<ImportedBlock> = Vec::new();
    let mut people_by_slot = BTreeMap::new();
    let mut singleton_indices = HashMap::<String, usize>::new();
    let mut missing_locations = 0usize;
    let mut unknown_locations = 0usize;
    let mut incomplete_people = 0usize;
    let mut legacy_acting_notes = 0usize;
    let mut personnel_formula_cells = 0usize;
    let next_anchors = groups
        .iter()
        .skip(1)
        .map(|group| group[0].number)
        .collect::<Vec<_>>();
    for (group_index, group) in groups.into_iter().enumerate() {
        let anchor = group[0];
        let metadata = |column| metadata_value(rows, merges, anchor, column);
        let section = metadata(0);
        let kind = if semantic_kinds {
            let stored_kind = value(anchor, 19);
            let kind = crate::bcs_rules::validated_kind(&stored_kind).ok_or_else(|| {
                format!(
                    "Рядок {}: службовий тип підрозділу пошкоджено або не підтримується.",
                    anchor.number
                )
            })?;
            if group
                .iter()
                .any(|row| cell(row, 19).has_formula || value(row, 19) != kind)
            {
                return Err(format!(
                    "Рядок {}: службові типи всередині блоку не збігаються.",
                    anchor.number
                ));
            }
            kind.to_string()
        } else {
            block_kind(&section, !metadata(4).is_empty()).to_string()
        };
        let crew = kind == "crew";
        let name = if crew {
            metadata(4)
        } else if section.is_empty() {
            "Інші".into()
        } else {
            section.clone()
        };
        let name = if name.is_empty() {
            push_warning(
                &mut warnings,
                format!(
                    "Рядок {}: назва екіпажу відсутня; встановіть її перед експортом.",
                    anchor.number
                ),
            );
            "Екіпаж".into()
        } else {
            name
        };
        if (0..10)
            .filter(|column| *column != 5 && *column != 6)
            .any(|column| metadata_cell(rows, merges, anchor, column).has_formula)
        {
            push_warning(&mut warnings, format!("Рядок {}: структурні поля містять формули. Перенесено лише збережені результати; формули не виконувалися. Перевірте дані блоку.", anchor.number));
        }
        if section.is_empty() && !crew {
            push_warning(&mut warnings, format!("Рядок {}: безіменний структурний блок збережено як «Інші»; усі його рядки перенесено.", anchor.number));
        }
        let crew_merge = merges.iter().find(|merge| {
            crew && merge.first_column == 4
                && merge.last_column == 4
                && merge.first_row == anchor.number
        });
        let section_merge = merges.iter().find(|merge| {
            merge.first_column == 0 && merge.last_column == 0 && merge.first_row == anchor.number
        });
        let merged_end = crew_merge
            .or(section_merge)
            .map_or(anchor.number, |merge| merge.last_row)
            .min(
                next_anchors
                    .get(group_index)
                    .map_or(usize::MAX, |next| next - 1),
            );
        let physical_slots = group
            .last()
            .map_or(1, |row| row.number.max(merged_end) - anchor.number + 1);
        let official_cell = metadata_cell(rows, merges, anchor, 6);
        let stated_slots = parsed_count(&official_cell.value);
        if official_cell.has_formula {
            push_warning(&mut warnings, format!("Рядок {}: «Кількість в/с» прочитано зі збереженого результату формули; формула не виконувалася.", anchor.number));
        }
        if stated_slots.is_none() {
            push_warning(&mut warnings, format!("Рядок {}: «Кількість в/с» не задано коректним числом; кількість місць визначено за рядками блоку ({}).", anchor.number, physical_slots));
        }
        let slots = stated_slots
            .unwrap_or(physical_slots as u32)
            .max(physical_slots as u32)
            .max(1);
        if slots > 2_000 {
            return Err(format!(
                "Рядок {}: у блоці понад 2 000 місць.",
                anchor.number
            ));
        }
        if stated_slots.is_some_and(|stated| stated != physical_slots as u32) {
            push_warning(&mut warnings, format!("Рядок {}: у «Кількість в/с» зазначено {}, фізичних рядків — {}. Збережено {} місць, жоден запис не відкинуто.", anchor.number, stated_slots.unwrap(), physical_slots, slots));
        }
        let actual = if crew {
            let count = metadata_cell(rows, merges, anchor, 5);
            if count.has_formula {
                push_warning(&mut warnings, format!("Рядок {}: фактичну чисельність прочитано зі збереженого результату формули; формула не виконувалася.", anchor.number));
            }
            parsed_count(&count.value).filter(|count| *count <= 2_000).unwrap_or_else(|| {
                push_warning(&mut warnings, format!("Рядок {}: фактична чисельність відсутня або некоректна. Залишено 0; вкажіть її вручну, вона не дорівнює автоматично кількості місць.", anchor.number));
                0
            })
        } else {
            0
        };
        let status = if crew {
            canonical(&metadata(7), &CREW_STATUSES)
        } else {
            String::new()
        };
        let uav_type = if crew {
            canonical(&metadata(9), &UAV_TYPES)
        } else {
            String::new()
        };
        if crew && !CREW_STATUSES.contains(&status.as_str()) {
            push_warning(&mut warnings, format!("Рядок {}: статус екіпажу не розпізнано. Початкове значення збережено; оберіть статус перед експортом.", anchor.number));
        }
        if crew && !UAV_TYPES.contains(&uav_type.as_str()) {
            push_warning(&mut warnings, format!("Рядок {}: тип БпАК не розпізнано. Початкове значення збережено; оберіть тип перед експортом.", anchor.number));
        }
        let merge_index = singleton_indices
            .get(&kind)
            .copied()
            .filter(|_| singleton(&kind));
        let (block_index, offset) = if let Some(index) = merge_index {
            let previous = &blocks[index];
            if previous.position_name != metadata(1)
                || previous.bro != metadata(2)
                || previous.work_sector != metadata(3)
                || previous.uav_name != metadata(8)
            {
                return Err(format!("Рядок {}: повторний блок «{}» має інші дані позиції або БпАК. Об’єднайте його в Excel перед імпортом, щоб не втратити ці дані.", anchor.number, previous.name));
            }
            let offset = blocks[index].slots;
            blocks[index].slots += slots;
            if blocks[index].slots > 2_000 {
                return Err(format!(
                    "Після об’єднання у блоці «{}» понад 2 000 місць.",
                    blocks[index].name
                ));
            }
            push_warning(
                &mut warnings,
                format!(
                    "Повторні блоки «{}» об’єднано в один; усі місця й записи збережено.",
                    blocks[index].name
                ),
            );
            (index, offset)
        } else {
            let index = blocks.len();
            let id = format!("imported-row-{}", anchor.number);
            if singleton(&kind) {
                singleton_indices.insert(kind.clone(), index);
            }
            blocks.push(ImportedBlock {
                id,
                kind: kind.clone(),
                name,
                position_name: metadata(1),
                slots,
                status,
                uav_type,
                bro: metadata(2),
                work_sector: metadata(3),
                uav_name: metadata(8),
                crew_actual: actual,
            });
            (index, 0)
        };
        let id = &blocks[block_index].id;
        for slot in 0..slots {
            let physical_row = anchor.number + slot as usize;
            let source = group.iter().find(|row| row.number == physical_row);
            let mut person = source.map_or_else(
                || ImportedPerson {
                    block_id: id.clone(),
                    ..ImportedPerson::default()
                },
                |row| person_from_row(row, id),
            );
            if person.rank.is_empty() || person.full_name.is_empty() || person.location.is_empty() {
                incomplete_people += 1;
            }
            if person.location.is_empty() {
                missing_locations += 1;
            } else if let Some(location) = schema
                .locations
                .iter()
                .find(|location| normalized(location) == normalized(&person.location))
            {
                person.location.clone_from(location);
            } else {
                unknown_locations += 1;
            }
            if kind == "temporary"
                && !person.position.to_uppercase().contains("ТВО")
                && person.note.to_uppercase().contains("ТВО:")
            {
                legacy_acting_notes += 1;
            }
            if let Some(row) = source {
                personnel_formula_cells += row
                    .cells
                    .iter()
                    .skip(10)
                    .take(6)
                    .filter(|cell| cell.has_formula)
                    .count();
            }
            people_by_slot.insert(format!("{id}:{}", offset + slot), person);
        }
    }
    let has_company = blocks.iter().any(|block| block.kind == "companyManagement");
    let has_platoon = blocks.iter().any(|block| block.kind == "platoonManagement");
    let structure_type = if has_company {
        "company"
    } else if has_platoon || normalized(&unit_name).contains("взвод") {
        "platoon"
    } else {
        "company"
    };
    let management = if structure_type == "company" {
        ("companyManagement", "Управління роти")
    } else {
        ("platoonManagement", "Управління взводу")
    };
    if !blocks.iter().any(|block| block.kind == management.0) {
        let id = "imported-required-management".to_string();
        blocks.push(ImportedBlock {
            id: id.clone(),
            kind: management.0.into(),
            name: management.1.into(),
            position_name: String::new(),
            slots: 1,
            status: String::new(),
            uav_type: String::new(),
            bro: String::new(),
            work_sector: String::new(),
            uav_name: String::new(),
            crew_actual: 0,
        });
        people_by_slot.insert(
            format!("{id}:0"),
            ImportedPerson {
                block_id: id,
                ..ImportedPerson::default()
            },
        );
        push_warning(&mut warnings, format!("У джерелі немає обов’язкового блоку «{}». Додано одне порожнє місце; заповніть або уточніть структуру перед експортом.", management.1));
    }
    if blocks
        .iter()
        .map(|block| block.slots as usize)
        .sum::<usize>()
        > 20_000
    {
        return Err("БЧС містить понад 20 000 місць.".into());
    }
    if missing_locations > 0 {
        warnings.push(format!("У {missing_locations} місцях відсутнє «Де знаходиться». Порожні значення збережено; заповніть їх перед експортом."));
    }
    if unknown_locations > 0 {
        warnings.push(format!("У {unknown_locations} місцях значення «Де знаходиться» відсутнє в чинному списку (зокрема старі об’єднані значення). Початковий текст збережено; оберіть відповідне значення перед експортом."));
    }
    if incomplete_people > 0 {
        warnings.push(format!("У {incomplete_people} місцях бракує мінімальних даних: звання, ПІБ або місця перебування. Імпорт збережено як чернетку; експорт стане доступним після заповнення."));
    }
    if legacy_acting_notes > 0 {
        warnings.push(format!("У {legacy_acting_notes} тимчасово прибулих ТВО вказано лише в примітці. Примітку збережено; для врахування ТВО у статистиці перенесіть запис у блок «Тимчасові з ТВО» або вкажіть ТВО в посаді."));
    }
    if personnel_formula_cells > 0 {
        warnings.push(format!("У персональних полях знайдено {personnel_formula_cells} формул. Перенесено лише їх збережені результати (або порожнє значення); формули не виконувалися. Перевірте ці поля."));
    }
    Ok(ImportedEditorWorkspace {
        version: 1,
        unit_name,
        report_date,
        structure_type: structure_type.into(),
        authorized_strength,
        blocks,
        people_by_slot,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(number: usize, values: &[(usize, &str)]) -> SheetRow {
        let mut cells = vec![Cell::default(); 16];
        for &(index, value) in values {
            cells[index].value = value.into();
        }
        SheetRow { number, cells }
    }

    fn fixture() -> (Vec<SheetRow>, Vec<MergeRange>) {
        let schema: Schema =
            serde_json::from_str(include_str!("../../src/shared/bcs-schema.json")).unwrap();
        let mut rows = vec![
            row(
                1,
                &[(0, "БЧС\n1 РУБАК\nстаном на 08:00 год 08.10.2026 року")],
            ),
            row(4, &[]),
        ];
        for (column, header) in schema.headers.iter().enumerate() {
            rows[1].cells[column].value.clone_from(header);
        }
        rows.extend([
            row(6, &[(0, "1 РУБАК")]),
            row(
                7,
                &[
                    (0, "Екіпаж"),
                    (1, "ПОЗИЦІЯ А"),
                    (2, "БРО-01"),
                    (3, "СЕКТОР А"),
                    (4, "ЕКІПАЖ А"),
                    (5, "3"),
                    (6, "2"),
                    (7, "Працюючий"),
                    (8, "БпАК А"),
                    (9, "ФПВ"),
                    (10, "Командир"),
                    (11, "сержант"),
                    (12, "ТЕСТОВИЙ Один"),
                    (13, "Обов’язки один"),
                    (14, "На позиції"),
                    (15, "Примітка один"),
                ],
            ),
            row(
                8,
                &[
                    (10, "Оператор"),
                    (11, "солдат"),
                    (12, "ТЕСТОВИЙ Два"),
                    (14, "ВІДП"),
                    (15, "Примітка два"),
                ],
            ),
            row(
                9,
                &[
                    (0, "Управління роти"),
                    (6, "1"),
                    (10, "Командир роти"),
                    (11, "капітан"),
                    (12, "ТЕСТОВИЙ Три"),
                    (14, "ПУ"),
                ],
            ),
            row(
                10,
                &[
                    (6, "2"),
                    (10, "Оператор"),
                    (11, "солдат"),
                    (12, "ТЕСТОВИЙ Чотири"),
                    (14, "Реко та облаштування"),
                ],
            ),
            row(
                11,
                &[(10, "Механік"), (11, "солдат"), (12, "ТЕСТОВИЙ Лук’ян")],
            ),
            row(
                12,
                &[
                    (0, "Тимчасово прибулі"),
                    (6, "1"),
                    (10, "Механік"),
                    (11, "солдат"),
                    (12, "ТЕСТОВИЙ Шість"),
                    (14, "ШТАБ"),
                    (15, "ТВО: тестова посада"),
                ],
            ),
            row(
                15,
                &[
                    (4, "БЧС 1 РУБАК:"),
                    (8, "БЧС по функціоналу:"),
                    (11, "Де знаходиться"),
                ],
            ),
            row(16, &[(4, "По штату"), (5, "13")]),
        ]);
        let merges = parse_merges("<mergeCells><mergeCell ref=\"A6:P6\"/><mergeCell ref=\"A7:A8\"/><mergeCell ref=\"A10:A11\"/></mergeCells>");
        (rows, merges)
    }

    #[test]
    fn keeps_all_personnel_fields_blocks_and_independent_actual_count() {
        let (rows, merges) = fixture();
        let workspace = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(workspace.unit_name, "1 РУБАК");
        assert_eq!(workspace.report_date, "2026-10-08");
        assert_eq!(workspace.authorized_strength, 13);
        assert_eq!(workspace.structure_type, "company");
        assert_eq!(
            workspace
                .blocks
                .iter()
                .map(|block| block.kind.as_str())
                .collect::<Vec<_>>(),
            ["crew", "companyManagement", "custom", "temporary"]
        );
        assert_eq!(
            workspace
                .blocks
                .iter()
                .map(|block| block.slots)
                .sum::<u32>(),
            6
        );
        assert_eq!(workspace.blocks[0].crew_actual, 3);
        assert_eq!(workspace.blocks[0].slots, 2);
        assert_eq!(workspace.blocks[2].name, "Інші");
        assert_eq!(workspace.blocks[0].position_name, "ПОЗИЦІЯ А");
        assert_eq!(workspace.blocks[0].uav_name, "БпАК А");
        assert_eq!(
            workspace.people_by_slot["imported-row-7:0"],
            person_from_row(&rows[3], "imported-row-7")
        );
        assert_eq!(workspace.people_by_slot["imported-row-10:1"].location, "");
        assert_eq!(
            workspace.people_by_slot["imported-row-10:0"].location,
            "Реко та облаштування"
        );
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("безіменний")));
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("У 1 місцях відсутнє")));
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("У 1 місцях значення")));
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("ТВО вказано лише в примітці")));
        let json = serde_json::to_value(&workspace).unwrap();
        assert_eq!(
            json["peopleBySlot"]["imported-row-7:0"]["blockId"],
            "imported-row-7"
        );
        assert!(json.get("unitName").is_some());
    }

    #[test]
    fn duplicate_singletons_combine_all_people_and_unknown_values_stay_visible() {
        let (mut rows, merges) = fixture();
        rows.insert(
            9,
            row(
                13,
                &[
                    (0, "Управління роти"),
                    (6, "1"),
                    (11, "солдат"),
                    (12, "ТЕСТОВИЙ Сім"),
                    (14, "Новий стан"),
                ],
            ),
        );
        rows[3].cells[7].value = "Невідомий статус".into();
        rows[3].cells[9].value = "Новий БпАК".into();
        let workspace = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(workspace.blocks.len(), 4);
        assert_eq!(workspace.blocks[1].slots, 2);
        assert_eq!(workspace.people_by_slot.len(), 7);
        assert_eq!(
            workspace.people_by_slot["imported-row-9:1"].full_name,
            "ТЕСТОВИЙ Сім"
        );
        assert_eq!(workspace.blocks[0].status, "Невідомий статус");
        assert_eq!(workspace.blocks[0].uav_type, "Новий БпАК");
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("Повторні блоки")));
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("статус екіпажу не розпізнано")));
    }

    #[test]
    fn expands_shared_merged_position_and_category_for_multiple_crews() {
        let (mut rows, _) = fixture();
        for row in &mut rows {
            if row.number >= 9 {
                row.number += 2;
            }
        }
        rows.insert(
            5,
            row(
                9,
                &[
                    (4, "ЕКІПАЖ Б"),
                    (5, "2"),
                    (6, "2"),
                    (7, "Працюючий"),
                    (8, "БпАК Б"),
                    (9, "Коптер"),
                    (10, "Оператор"),
                    (11, "солдат"),
                    (12, "ТЕСТОВИЙ Вісім"),
                    (14, "На позиції"),
                ],
            ),
        );
        rows.insert(
            6,
            row(
                10,
                &[
                    (10, "Механік"),
                    (11, "солдат"),
                    (12, "ТЕСТОВИЙ Дев’ять"),
                    (14, "ПУ"),
                ],
            ),
        );
        let merges = parse_merges("<mergeCells><mergeCell ref=\"A6:P6\"/><mergeCell ref=\"A7:A10\"/><mergeCell ref=\"B7:B10\"/><mergeCell ref=\"C7:C10\"/><mergeCell ref=\"D7:D10\"/><mergeCell ref=\"E7:E8\"/><mergeCell ref=\"E9:E10\"/><mergeCell ref=\"A12:A13\"/></mergeCells>");
        let imported = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(imported.blocks.len(), 5);
        assert_eq!(imported.blocks[0].slots, 2);
        assert_eq!(imported.blocks[1].slots, 2);
        assert_eq!(imported.blocks[1].name, "ЕКІПАЖ Б");
        assert_eq!(imported.blocks[1].kind, "crew");
        assert_eq!(imported.blocks[1].position_name, "ПОЗИЦІЯ А");
        assert_eq!(imported.blocks[1].bro, "БРО-01");
        assert_eq!(imported.blocks[1].work_sector, "СЕКТОР А");
        assert_eq!(imported.people_by_slot.len(), 8);
        assert_eq!(
            imported.people_by_slot["imported-row-9:1"].full_name,
            "ТЕСТОВИЙ Дев’ять"
        );
    }

    #[test]
    fn never_truncates_rows_when_stated_official_count_is_smaller() {
        let (mut rows, merges) = fixture();
        rows[3].cells[6].value = "1".into();
        rows[3].cells[5].has_formula = true;
        rows[3].cells[5].value.clear();
        let workspace = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(workspace.blocks[0].slots, 2);
        assert_eq!(workspace.blocks[0].crew_actual, 0);
        assert_eq!(
            workspace.people_by_slot["imported-row-7:1"].full_name,
            "ТЕСТОВИЙ Два"
        );
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("жоден запис не відкинуто")));
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("вона не дорівнює автоматично кількості місць")));
    }

    #[test]
    fn keeps_empty_physical_slots_and_cached_formulas_without_evaluating_them() {
        let (mut rows, mut merges) = fixture();
        rows[3].cells[6].has_formula = true;
        rows[3].cells[6].value = "3".into();
        rows[3].cells[5].has_formula = true;
        rows[3].cells[5].value = "7".into();
        rows[3].cells[15].has_formula = true;
        rows[3].cells[15].value = "Збережений текст".into();
        rows[4].cells[12].has_formula = true;
        rows[4].cells[12].value.clear();
        merges.push(MergeRange {
            first_column: 0,
            last_column: 0,
            first_row: 7,
            last_row: 8,
        });
        let workspace = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(workspace.blocks[0].slots, 3);
        assert_eq!(workspace.blocks[0].crew_actual, 7);
        assert_eq!(
            workspace.people_by_slot["imported-row-7:0"].note,
            "Збережений текст"
        );
        assert_eq!(workspace.people_by_slot["imported-row-7:1"].full_name, "");
        assert_eq!(
            workspace.people_by_slot["imported-row-7:2"],
            ImportedPerson {
                block_id: "imported-row-7".into(),
                ..ImportedPerson::default()
            }
        );
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("2 формул")));
    }

    #[test]
    fn rejects_macros_before_reading_workbook_and_checks_real_calendar_dates() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("macro.xlsx");
        let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
        archive
            .start_file(
                "xl/vbaProject.bin",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"untrusted macro").unwrap();
        archive.finish().unwrap();
        assert!(import_bcs_editor(path.to_string_lossy().into_owned())
            .unwrap_err()
            .contains("макросами"));
        assert_eq!(title_date("29.02.2024"), Some("2024-02-29".into()));
        assert_eq!(title_date("29.02.2025"), None);
        assert_eq!(title_date("31.04.2026"), None);
    }

    #[test]
    fn missing_required_management_gets_one_explicit_empty_slot() {
        let (mut rows, merges) = fixture();
        rows[5].cells[0].value = "Відділення тест".into();
        let workspace = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(workspace.blocks.last().unwrap().kind, "companyManagement");
        assert_eq!(
            workspace.people_by_slot["imported-required-management:0"].full_name,
            ""
        );
        assert!(workspace
            .warnings
            .iter()
            .any(|warning| warning.contains("Додано одне порожнє місце")));
    }

    #[test]
    fn rejects_multi_unit_summary_and_unsupported_headers() {
        let (mut rows, merges) = fixture();
        rows[0].cells[0].value.insert_str(0, "Зведений ");
        assert!(parse_workspace(&rows, &merges)
            .unwrap_err()
            .contains("Зведений БЧС"));
        rows[0].cells[0].value = "БЧС 08.10.2026".into();
        rows.insert(10, row(14, &[(0, "2 РУБАК")]));
        let mut with_second_banner = merges.clone();
        with_second_banner.push(MergeRange {
            first_column: 0,
            last_column: 15,
            first_row: 14,
            last_row: 14,
        });
        assert!(parse_workspace(&rows, &with_second_banner)
            .unwrap_err()
            .contains("декілька блоків"));
        rows[1].cells[12].value = "Непідтримувана колонка".into();
        assert!(parse_workspace(&rows, &merges)
            .unwrap_err()
            .contains("16 колонок"));
    }

    #[test]
    fn exports_and_reimports_complete_fixture_without_losing_personal_fields() {
        let (mut rows, merges) = fixture();
        rows[6].cells[14].value = "Реко".into();
        rows[7].cells[14].value = "ОХ".into();
        let imported = parse_workspace(&rows, &merges).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("roundtrip.xlsx");
        let mut people = Vec::new();
        for block in &imported.blocks {
            for slot in 0..block.slots {
                people.push(
                    serde_json::to_value(&imported.people_by_slot[&format!("{}:{slot}", block.id)])
                        .unwrap(),
                );
            }
        }
        let request: crate::generator::FilledBcsRequest = serde_json::from_value(json!({
            "unitName": imported.unit_name, "reportDate":"08.10.2026", "structureType":imported.structure_type, "authorizedStrength": imported.authorized_strength,
            "blocks":imported.blocks, "people":people, "outputPath":path.to_str().unwrap(),
        })).unwrap();
        crate::generator::export_filled(request).unwrap();
        let reimported = import_bcs_editor(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(reimported.blocks.len(), imported.blocks.len());
        assert_eq!(reimported.blocks[0].slots, 2);
        assert_eq!(reimported.blocks[0].crew_actual, 3);
        assert_eq!(
            reimported.people_by_slot.len(),
            imported.people_by_slot.len()
        );
        let without_id = |person: &ImportedPerson| {
            let mut copy = person.clone();
            copy.block_id.clear();
            copy
        };
        let original_people = imported
            .blocks
            .iter()
            .flat_map(|block| {
                (0..block.slots).map(|slot| {
                    without_id(&imported.people_by_slot[&format!("{}:{slot}", block.id)])
                })
            })
            .collect::<Vec<_>>();
        let restored_people = reimported
            .blocks
            .iter()
            .flat_map(|block| {
                (0..block.slots).map(|slot| {
                    without_id(&reimported.people_by_slot[&format!("{}:{slot}", block.id)])
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(original_people, restored_people);
    }

    #[test]
    fn a_unit_name_containing_summary_words_is_not_a_general_report() {
        let (mut rows, merges) = fixture();
        rows[0].cells[0].value = "БЧС\nЗведена рота\nстаном на 08:00 год 08.10.2026 року".into();
        rows.iter_mut().find(|row| row.number == 6).unwrap().cells[0].value = "Зведена рота".into();
        let restored = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(restored.unit_name, "Зведена рота");
        assert_eq!(restored.people_by_slot.len(), 6);
    }

    #[test]
    fn semantic_kinds_preserve_a_department_named_like_an_external_category() {
        let (mut rows, merges) = fixture();
        for row in &mut rows {
            row.cells.resize_with(20, Cell::default);
            let kind = match row.number {
                4 => "__BCS_KIND_V1",
                7 | 8 => "crew",
                9 => "companyManagement",
                10 | 11 => "department",
                12 => "temporary",
                _ => "",
            };
            row.cells[19].value = kind.into();
            if row.number == 10 {
                row.cells[0].value = "Прикомандировані".into();
            }
        }
        let restored = parse_workspace(&rows, &merges).unwrap();
        assert_eq!(restored.blocks[2].kind, "department");
        assert_eq!(restored.blocks[2].name, "Прикомандировані");
        assert_eq!(restored.blocks[2].slots, 2);
        assert_eq!(restored.people_by_slot.len(), 6);

        rows.iter_mut().find(|row| row.number == 11).unwrap().cells[19].value = "attached".into();
        assert!(parse_workspace(&rows, &merges)
            .unwrap_err()
            .contains("не збігаються"));
    }

    #[test]
    fn a_crew_named_like_a_footer_label_keeps_all_rows_and_authorized_strength() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        for legacy in [false, true] {
            let path = directory.path().join(format!("footer-name-{legacy}.xlsx"));
            let people = ["c1", "c1", "c2", "c2", "m"].into_iter().enumerate().map(|(index, block_id)| json!({
                "blockId": block_id, "fullName": format!("ТЕСТ-{index} Іван"), "rank":"солдат", "location":"ПУ"
            })).collect::<Vec<_>>();
            let request = serde_json::from_value(json!({
                "unitName":"ТЕСТ", "reportDate":"08.10.2026", "structureType":"company", "authorizedStrength":72,
                "blocks":[
                    {"id":"c1","kind":"crew","name":"ПЕРШИЙ","slots":2,"crewActual":3,"status":"Працюючий","uavType":"ФПВ"},
                    {"id":"c2","kind":"crew","name":"По штату","slots":2,"crewActual":4,"status":"Працюючий","uavType":"ФПВ"},
                    {"id":"m","kind":"companyManagement","name":"Управління роти","slots":1}
                ], "people":people, "outputPath":path.to_string_lossy()
            })).unwrap();
            crate::generator::export_filled(request).unwrap();

            // A legacy layout may merge the category across multiple crews.
            // The second E-cell remains a real crew name, not a footer label.
            let mut archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
            let mut entries = Vec::new();
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                entries.push((entry.name().to_string(), bytes));
            }
            drop(archive);
            let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
            for (name, mut bytes) in entries {
                if name == "xl/worksheets/sheet1.xml" {
                    let mut xml = String::from_utf8(bytes).unwrap();
                    for coordinate in if legacy { vec!["A9", "T4"] } else { vec!["A9"] } {
                        let start = xml.find(&format!("<c r=\"{coordinate}\"")).unwrap();
                        let end = start + xml[start..].find("</c>").unwrap() + 4;
                        xml.replace_range(start..end, "");
                    }
                    let mut merges = parse_merges(&xml);
                    merges.retain(|merge| {
                        !(merge.first_column == 0
                            && merge.last_column == 0
                            && matches!(merge.first_row, 7 | 9))
                    });
                    merges.push(MergeRange {
                        first_column: 0,
                        last_column: 0,
                        first_row: 7,
                        last_row: 10,
                    });
                    let merge_xml = format!(
                        "<mergeCells count=\"{}\">{}</mergeCells>",
                        merges.len(),
                        merges
                            .iter()
                            .map(|merge| format!(
                                "<mergeCell ref=\"{}{}:{}{}\"/>",
                                (b'A' + merge.first_column as u8) as char,
                                merge.first_row,
                                (b'A' + merge.last_column as u8) as char,
                                merge.last_row
                            ))
                            .collect::<String>()
                    );
                    let start = xml.find("<mergeCells ").unwrap();
                    let end =
                        start + xml[start..].find("</mergeCells>").unwrap() + "</mergeCells>".len();
                    xml.replace_range(start..end, &merge_xml);
                    bytes = xml.into_bytes();
                }
                writer
                    .start_file(
                        name,
                        zip::write::SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Deflated),
                    )
                    .unwrap();
                writer.write_all(&bytes).unwrap();
            }
            writer.finish().unwrap();
            let imported = import_bcs_editor(path.to_string_lossy().into_owned()).unwrap();
            assert_eq!(imported.blocks.len(), 3, "legacy={legacy}");
            assert_eq!(imported.people_by_slot.len(), 5, "legacy={legacy}");
            assert_eq!(imported.authorized_strength, 72, "legacy={legacy}");
            assert_eq!(imported.blocks[1].name, "ПО ШТАТУ", "legacy={legacy}");
            assert_eq!(
                imported
                    .blocks
                    .iter()
                    .filter(|block| block.kind == "crew")
                    .map(|block| block.crew_actual)
                    .sum::<u32>(),
                7
            );
            assert!(imported
                .people_by_slot
                .values()
                .all(|person| !person.full_name.is_empty()));
        }
    }

    #[test]
    #[ignore = "Requires the user-provided private XLSX fixture via BCSEDITOR_IMPORT_FIXTURE"]
    fn audits_private_reference_without_committing_personnel() {
        let path = std::env::var("BCSEDITOR_IMPORT_FIXTURE").expect("BCSEDITOR_IMPORT_FIXTURE");
        let imported = import_bcs_editor(path.clone()).unwrap();
        // Current readonly reference: 19 source anchors (including separate ТВО),
        // independently audited from the XLSX XML, not inferred from the importer.
        assert_eq!(imported.blocks.len(), 19);
        assert_eq!(imported.people_by_slot.len(), 74);
        assert_eq!(
            imported
                .blocks
                .iter()
                .filter(|block| block.kind == "crew")
                .count(),
            12
        );
        assert_eq!(
            imported
                .blocks
                .iter()
                .filter(|block| block.kind == "crew")
                .map(|block| block.crew_actual)
                .sum::<u32>(),
            47
        );
        assert_eq!(
            imported
                .blocks
                .iter()
                .filter(|block| block.kind == "crew")
                .map(|block| block.slots)
                .sum::<u32>(),
            46
        );
        assert_eq!(imported.authorized_strength, 72);
        assert_eq!(imported.report_date, "2026-10-08");
        assert_eq!(imported.blocks[15].kind, "custom");
        assert_eq!(imported.blocks[15].slots, 2);
        assert_eq!(
            imported
                .people_by_slot
                .values()
                .filter(|person| !person.note.is_empty())
                .count(),
            46
        );
        assert_eq!(
            imported
                .people_by_slot
                .values()
                .filter(|person| !person.duties.is_empty())
                .count(),
            50
        );
        assert_eq!(
            imported
                .people_by_slot
                .values()
                .filter(|person| person.location.is_empty())
                .count(),
            0
        );
        let schema: Schema =
            serde_json::from_str(include_str!("../../src/shared/bcs-schema.json")).unwrap();
        assert_eq!(
            imported
                .people_by_slot
                .values()
                .filter(|person| !person.location.is_empty()
                    && !schema.locations.contains(&person.location))
                .count(),
            0
        );
        assert_eq!(
            imported
                .blocks
                .iter()
                .filter(|block| block.kind == "temporary")
                .map(|block| block.slots)
                .sum::<u32>(),
            1
        );
        assert_eq!(
            imported
                .blocks
                .iter()
                .filter(|block| block.kind == "temporaryActing")
                .map(|block| block.slots)
                .sum::<u32>(),
            1
        );
        let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
        let rows = xlsx::read_bcs_sheet(&mut archive).unwrap();
        let source_anchors = [
            7, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 63, 67, 75, 77, 79, 80,
        ];
        assert_eq!(
            imported
                .blocks
                .iter()
                .map(|block| block
                    .id
                    .strip_prefix("imported-row-")
                    .unwrap()
                    .parse::<usize>()
                    .unwrap())
                .collect::<Vec<_>>(),
            source_anchors
        );
        for block in &imported.blocks {
            let first = block
                .id
                .strip_prefix("imported-row-")
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let anchor = rows.iter().find(|row| row.number == first).unwrap();
            assert!(
                block.position_name == value(anchor, 1),
                "Position field mismatch at row {first}"
            );
            assert!(
                block.bro == value(anchor, 2),
                "BRO field mismatch at row {first}"
            );
            assert!(
                block.work_sector == value(anchor, 3),
                "Sector field mismatch at row {first}"
            );
            if block.kind == "crew" {
                assert!(
                    block.name == value(anchor, 4),
                    "Crew name mismatch at row {first}"
                );
                assert!(
                    block.status == value(anchor, 7),
                    "Crew status mismatch at row {first}"
                );
                assert!(
                    block.uav_name == value(anchor, 8),
                    "UAV name mismatch at row {first}"
                );
                assert!(
                    block.uav_type == value(anchor, 9),
                    "UAV type mismatch at row {first}"
                );
                assert_eq!(Some(block.crew_actual), parsed_count(&value(anchor, 5)));
            }
            for slot in 0..block.slots {
                let row = rows
                    .iter()
                    .find(|row| row.number == first + slot as usize)
                    .unwrap();
                assert!(
                    imported.people_by_slot[&format!("{}:{slot}", block.id)]
                        == person_from_row(row, &block.id),
                    "Personal field mismatch at row {}",
                    row.number
                );
            }
        }
        if let Ok(output) = std::env::var("BCSEDITOR_IMPORT_JSON_OUTPUT") {
            let output = Path::new(&output);
            assert!(
                output.starts_with("/private/tmp") || output.starts_with("/tmp"),
                "Private fixture output must stay in a temporary directory"
            );
            std::fs::write(output, serde_json::to_vec_pretty(&imported).unwrap()).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(output, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
    }
}
