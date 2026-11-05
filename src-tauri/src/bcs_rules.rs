/// The same person must have the same key before export and after XLSX import.
/// BOM is treated as whitespace too, matching pasted text in the editor.
pub(crate) fn person_key(value: &str) -> String {
    value
        .split(|character: char| character.is_whitespace() || character == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase()
}

/// Shared with the editor and with Excel's dynamically recalculated helper.
pub(crate) fn tvo_delimiters() -> &'static str {
    static DELIMITERS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DELIMITERS.get_or_init(|| {
        let rules: serde_json::Value =
            serde_json::from_str(include_str!("../../src/shared/bcs-rules.json"))
                .expect("built-in BCS calculation rules must be valid JSON");
        rules["tvoDelimiters"]
            .as_str()
            .expect("built-in delimiters must be text")
            .to_string()
    })
}

/// ТВО must be separated by whitespace or punctuation, not embedded in a word.
pub(crate) fn is_tvo_position(value: &str) -> bool {
    value
        .split(|character: char| tvo_delimiters().contains(character))
        .any(|part| part.to_uppercase() == "ТВО")
}

pub(crate) fn validated_kind(value: &str) -> Option<&'static str> {
    match value {
        "crew" => Some("crew"),
        "companyManagement" => Some("companyManagement"),
        "platoonManagement" => Some("platoonManagement"),
        "department" => Some("department"),
        "informationDepartment" => Some("informationDepartment"),
        "independent" => Some("independent"),
        "custom" => Some("custom"),
        "attached" => Some("attached"),
        "operationalSubordination" => Some("operationalSubordination"),
        "temporary" => Some("temporary"),
        "temporaryActing" => Some("temporaryActing"),
        "unassigned" => Some("unassigned"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personnel_key_is_stable_for_case_and_unicode_spacing() {
        for name in [
            "тестовий іван",
            " ТЕСТОВИЙ  Іван ",
            "ТЕСТОВИЙ\u{a0}Іван",
            "\u{feff}ТЕСТОВИЙ\u{85}\tІван\n",
        ] {
            assert_eq!(person_key(name), "ТЕСТОВИЙ ІВАН");
        }
    }

    #[test]
    fn acting_assignment_requires_a_complete_abbreviation() {
        for position in [
            "ТВО командира",
            "(тво): водій",
            "водій — ТВО",
            "ТВО_командира",
        ] {
            assert!(is_tvo_position(position), "{position}");
        }
        for position in [
            "Відповідальний за діловодство",
            "Виконавець робіт (будівництво)",
            "Творчий працівник",
            "ТВО1",
            "ПРИТВО",
            "",
        ] {
            assert!(!is_tvo_position(position), "{position}");
        }
    }
}
