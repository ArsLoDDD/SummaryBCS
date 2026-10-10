use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

pub const MAX_ARCHIVE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 80 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;

#[derive(Debug, Clone, Default)]
pub struct Cell {
    pub value: String,
    pub style: Option<usize>,
    pub has_formula: bool,
}

#[derive(Debug, Clone)]
pub struct SheetRow {
    pub number: usize,
    pub cells: Vec<Cell>,
}

pub fn validate_archive(archive: &mut ZipArchive<File>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("XLSX містить забагато внутрішніх файлів.".into());
    }
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "Не вдалося перевірити структуру XLSX.".to_string())?;
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| "XLSX має некоректний розмір.".to_string())?;
        if total > MAX_UNCOMPRESSED_BYTES {
            return Err("XLSX завеликий після розпакування.".into());
        }
        if entry.name().ends_with("vbaProject.bin") {
            return Err("Файли з макросами не підтримуються. Експортуйте БЧС як .xlsx.".into());
        }
    }
    Ok(())
}

fn read_text(archive: &mut ZipArchive<File>, name: &str) -> Result<String, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("XLSX не містить «{name}»."))?;
    if entry.size() > MAX_XML_BYTES {
        return Err(format!("Внутрішній файл «{name}» завеликий."));
    }
    let mut xml = String::new();
    entry
        .read_to_string(&mut xml)
        .map_err(|_| format!("Не вдалося прочитати «{name}» як XML."))?;
    Ok(xml)
}

fn optional_text(archive: &mut ZipArchive<File>, name: &str) -> Result<Option<String>, String> {
    match archive.by_name(name) {
        Ok(mut entry) => {
            if entry.size() > MAX_XML_BYTES {
                return Err(format!("Внутрішній файл «{name}» завеликий."));
            }
            let mut xml = String::new();
            entry
                .read_to_string(&mut xml)
                .map_err(|_| format!("Не вдалося прочитати «{name}» як XML."))?;
            Ok(Some(xml))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(_) => Err(format!("Не вдалося прочитати «{name}».")),
    }
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&#10;", "\n")
        .replace("&#13;", "\r")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn attribute(fragment: &str, name: &str) -> Option<String> {
    fragment
        .split_once(&format!("{name}=\""))?
        .1
        .split_once('"')
        .map(|(value, _)| xml_unescape(value))
}

fn text_nodes(fragment: &str) -> String {
    fragment
        .split("<t")
        .skip(1)
        .filter_map(|part| part.split_once('>').map(|(_, tail)| tail))
        .filter_map(|part| part.split_once("</t>").map(|(text, _)| text))
        .map(xml_unescape)
        .collect()
}

fn shared_strings(archive: &mut ZipArchive<File>) -> Result<Vec<String>, String> {
    let Some(xml) = optional_text(archive, "xl/sharedStrings.xml")? else {
        return Ok(Vec::new());
    };
    let xml = xml.replace("<x:", "<").replace("</x:", "</");
    Ok(xml
        .split("<si>")
        .skip(1)
        .filter_map(|item| item.split_once("</si>").map(|(value, _)| value))
        .map(text_nodes)
        .collect())
}

fn column_index(reference: &str) -> Option<usize> {
    let mut value = 0usize;
    let mut found = false;
    for letter in reference
        .chars()
        .take_while(|character| character.is_ascii_alphabetic())
    {
        found = true;
        value = value
            .checked_mul(26)?
            .checked_add((letter.to_ascii_uppercase() as u8 - b'A' + 1) as usize)?;
    }
    found.then_some(value - 1)
}

fn cell_value(fragment: &str, shared: &[String]) -> String {
    let inline = text_nodes(fragment);
    if !inline.is_empty() {
        return inline;
    }
    let raw = fragment
        .split_once("<v>")
        .and_then(|(_, value)| value.split_once("</v>"))
        .map(|(value, _)| value)
        .unwrap_or("");
    if fragment.contains("t=\"s\"") {
        return raw
            .parse::<usize>()
            .ok()
            .and_then(|index| shared.get(index))
            .cloned()
            .unwrap_or_default();
    }
    xml_unescape(raw)
}

fn worksheet_rows(xml: &str, shared: &[String]) -> Vec<SheetRow> {
    let xml = xml.replace("<x:", "<").replace("</x:", "</");
    xml.split("<row ")
        .skip(1)
        .filter_map(|raw| {
            let (row, _) = raw.split_once("</row>")?;
            let opening = row.split_once('>').map(|(opening, _)| opening)?;
            let number = attribute(opening, "r")?.parse::<usize>().ok()?;
            let parsed = row
                .split("<c ")
                .skip(1)
                .filter_map(|cell| {
                    let fragment = cell.split_once("</c>").map(|(value, _)| value)?;
                    let opening = fragment.split_once('>').map(|(value, _)| value)?;
                    let index = column_index(&attribute(opening, "r")?)?;
                    Some((
                        index,
                        Cell {
                            value: cell_value(fragment, shared),
                            style: attribute(opening, "s").and_then(|value| value.parse().ok()),
                            has_formula: fragment.contains("<f") || fragment.contains(":f"),
                        },
                    ))
                })
                .collect::<Vec<_>>();
            let length = parsed.iter().map(|(index, _)| index + 1).max().unwrap_or(0);
            let mut cells = vec![Cell::default(); length];
            for (index, cell) in parsed {
                cells[index] = cell;
            }
            Some(SheetRow { number, cells })
        })
        .collect()
}

fn worksheet_path(archive: &mut ZipArchive<File>, expected_name: &str) -> Result<String, String> {
    let workbook = read_text(archive, "xl/workbook.xml")?;
    let workbook = workbook.replace("<x:", "<").replace("</x:", "</");
    let relationship_id = workbook
        .split("<sheet ")
        .skip(1)
        .filter_map(|sheet| sheet.split_once('>').map(|(opening, _)| opening))
        .find(|sheet| attribute(sheet, "name").as_deref() == Some(expected_name))
        .and_then(|sheet| attribute(sheet, "r:id"))
        .ok_or_else(|| format!("Відсутній аркуш «{expected_name}»."))?;

    let relationships = read_text(archive, "xl/_rels/workbook.xml.rels")?;
    let relationship = relationships
        .split("<Relationship ")
        .skip(1)
        .filter_map(|item| item.split_once('>').map(|(opening, _)| opening))
        .find(|item| attribute(item, "Id").as_deref() == Some(&relationship_id))
        .ok_or_else(|| format!("Не вдалося знайти зв’язок аркуша «{expected_name}»."))?;
    if attribute(relationship, "TargetMode").as_deref() == Some("External") {
        return Err("Зовнішні аркуші не підтримуються.".into());
    }
    let target = attribute(relationship, "Target")
        .ok_or_else(|| format!("Аркуш «{expected_name}» не має внутрішнього шляху."))?;
    let target = target.trim_start_matches('/').replace('\\', "/");
    let path = if target.starts_with("xl/") {
        target
    } else {
        format!("xl/{target}")
    };
    if !path.starts_with("xl/worksheets/") || path.contains("..") {
        return Err("Некоректний внутрішній шлях аркуша XLSX.".into());
    }
    Ok(path)
}

pub fn read_bcs_sheet(archive: &mut ZipArchive<File>) -> Result<Vec<SheetRow>, String> {
    let shared = shared_strings(archive)?;
    let path = worksheet_path(archive, "БЧС")?;
    let xml = read_text(archive, &path)?;
    Ok(worksheet_rows(&xml, &shared))
}

fn esc(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn write_styled_workbook(
    path: &Path,
    sheet_name: &str,
    sheet_xml: &str,
    styles: &str,
    theme: &str,
) -> Result<(), String> {
    let file = File::create(path).map_err(|_| "Не вдалося створити Excel-файл.".to_string())?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    let files = [
        (
            "[Content_Types].xml",
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/xl/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/></Types>".to_string(),
        ),
        (
            "_rels/.rels",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>".to_string(),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rIdTheme\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/></Relationships>".to_string(),
        ),
        (
            "xl/workbook.xml",
            format!("<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>", esc(sheet_name)),
        ),
        ("xl/styles.xml", styles.to_string()),
        ("xl/theme/theme1.xml", theme.to_string()),
        ("xl/worksheets/sheet1.xml", sheet_xml.to_string()),
    ];

    for (name, content) in files {
        archive
            .start_file(name, options)
            .map_err(|_| "Не вдалося сформувати Excel-файл.".to_string())?;
        archive
            .write_all(content.as_bytes())
            .map_err(|_| "Не вдалося записати Excel-файл.".to_string())?;
    }
    archive
        .finish()
        .map_err(|_| "Не вдалося завершити Excel-файл.".to_string())?;
    Ok(())
}

/// Writes the editable BCS workbook used by the template builder and the
/// in-app editor.  Keeping this separate from `write_styled_workbook` avoids
/// changing the byte layout of the already tested summary export.
pub fn write_bcs_workbook_with_dictionaries(
    path: &Path,
    bcs_sheet_xml: &str,
    dictionaries_sheet_xml: &str,
    styles: &str,
    theme: &str,
    defined_names_xml: &str,
) -> Result<(), String> {
    let file = File::create(path).map_err(|_| "Не вдалося створити Excel-файл.".to_string())?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    let files = [
        (
            "[Content_Types].xml",
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/worksheets/sheet2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/xl/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/></Types>".to_string(),
        ),
        (
            "_rels/.rels",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>".to_string(),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/><Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rIdTheme\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/></Relationships>".to_string(),
        ),
        (
            "xl/workbook.xml",
            format!(
                "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"БЧС\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Довідники\" sheetId=\"2\" r:id=\"rId2\"/></sheets><definedNames>{defined_names_xml}</definedNames><calcPr calcId=\"191029\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>"
            ),
        ),
        ("xl/styles.xml", styles.to_string()),
        ("xl/theme/theme1.xml", theme.to_string()),
        ("xl/worksheets/sheet1.xml", bcs_sheet_xml.to_string()),
        (
            "xl/worksheets/sheet2.xml",
            dictionaries_sheet_xml.to_string(),
        ),
    ];

    for (name, content) in files {
        archive
            .start_file(name, options)
            .map_err(|_| "Не вдалося сформувати Excel-файл.".to_string())?;
        archive
            .write_all(content.as_bytes())
            .map_err(|_| "Не вдалося записати Excel-файл.".to_string())?;
    }
    archive
        .finish()
        .map_err(|_| "Не вдалося завершити Excel-файл.".to_string())?;
    Ok(())
}
