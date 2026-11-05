use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAGIC: &[u8] = b"BCSDRAFT1";
const KEY_LENGTH: usize = 32;
const NONCE_LENGTH: usize = 12;
const MAX_DRAFT_SIZE: usize = 20 * 1024 * 1024;
const AUTHENTICATION_TAG_LENGTH: usize = 16;
const MAX_STORED_SIZE: usize =
    MAGIC.len() + NONCE_LENGTH + MAX_DRAFT_SIZE + AUTHENTICATION_TAG_LENGTH;
static DRAFT_ACCESS: Mutex<()> = Mutex::new(());

fn safe_variant(variant: &str) -> Result<&str, String> {
    match variant {
        "template" | "editor" | "strips" | "strips-registry" => Ok(variant),
        _ => Err("Невідомий тип чернетки.".into()),
    }
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Не вдалося визначити системну папку програми.".to_string())?;
    fs::create_dir_all(&directory)
        .map_err(|_| "Не вдалося створити системну папку програми.".to_string())?;
    Ok(directory)
}

#[cfg(unix)]
fn private_options() -> OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    options
}

#[cfg(not(unix))]
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    options
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut suffix = [0u8; 8];
    getrandom::getrandom(&mut suffix)
        .map_err(|_| "Не вдалося підготувати збереження чернетки.".to_string())?;
    let suffix = u64::from_le_bytes(suffix);
    let filename = path
        .file_name()
        .ok_or_else(|| "Неправильний шлях чернетки.".to_string())?
        .to_string_lossy();
    let temporary = path.with_file_name(format!(".{filename}.{suffix:016x}.tmp"));
    let mut file = private_options()
        .open(&temporary)
        .map_err(|_| "Не вдалося записати захищену чернетку.".to_string())?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Не вдалося записати захищену чернетку.".to_string())?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|_| "Не вдалося оновити захищену чернетку.".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn load_key(directory: &Path) -> Result<[u8; KEY_LENGTH], String> {
    let path = directory.join(".bcs-draft.key");
    let mut bytes = Vec::new();
    File::open(&path)
        .and_then(|file| file.take((KEY_LENGTH + 1) as u64).read_to_end(&mut bytes))
        .map_err(|_| "Не вдалося прочитати ключ чернетки. Існуючі дані не змінено.".to_string())?;
    let key = bytes
        .try_into()
        .map_err(|_| "Ключ чернетки пошкоджений.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Не вдалося захистити ключ чернетки.".to_string())?;
    }
    Ok(key)
}

fn load_or_create_key(directory: &Path) -> Result<[u8; KEY_LENGTH], String> {
    let path = directory.join(".bcs-draft.key");
    if path
        .try_exists()
        .map_err(|_| "Не вдалося перевірити ключ чернетки.".to_string())?
    {
        return load_key(directory);
    }

    // Never replace a missing key while any encrypted workspace still exists.
    // Doing so would make a recoverable draft inaccessible and permit overwriting it.
    for entry in fs::read_dir(directory)
        .map_err(|_| "Не вдалося перевірити збережені чернетки.".to_string())?
    {
        let entry = entry.map_err(|_| "Не вдалося перевірити збережені чернетки.".to_string())?;
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "bcsdata" || extension == "bcsbackup")
        {
            return Err("Ключ чернетки відсутній. Існуючі дані не змінено.".into());
        }
    }

    let mut key = [0u8; KEY_LENGTH];
    getrandom::getrandom(&mut key)
        .map_err(|_| "Не вдалося створити ключ шифрування.".to_string())?;
    write_private(&path, &key)?;
    Ok(key)
}

fn draft_path(directory: &Path, variant: &str) -> PathBuf {
    directory.join(format!("workspace-{variant}.bcsdata"))
}

pub fn save(app: tauri::AppHandle, variant: String, payload: String) -> Result<(), String> {
    let directory = app_data_dir(&app)?;
    save_to_directory(&directory, &variant, &payload)
}

fn save_to_directory(directory: &Path, variant: &str, payload: &str) -> Result<(), String> {
    let variant = safe_variant(variant)?;
    if payload.len() > MAX_DRAFT_SIZE {
        return Err("Чернетка завелика для автоматичного збереження.".into());
    }
    serde_json::from_str::<serde_json::Value>(payload)
        .map_err(|_| "Чернетка має неправильний формат.".to_string())?;

    let _access = DRAFT_ACCESS
        .lock()
        .map_err(|_| "Збереження чернетки тимчасово недоступне.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|_| "Не вдалося створити системну папку програми.".to_string())?;
    let key_bytes = load_or_create_key(directory)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let mut nonce_bytes = [0u8; NONCE_LENGTH];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|_| "Не вдалося створити шифр чернетки.".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: payload.as_bytes(),
                aad: variant.as_bytes(),
            },
        )
        .map_err(|_| "Не вдалося зашифрувати чернетку.".to_string())?;

    let mut stored = Vec::with_capacity(MAGIC.len() + NONCE_LENGTH + ciphertext.len());
    stored.extend_from_slice(MAGIC);
    stored.extend_from_slice(&nonce_bytes);
    stored.extend_from_slice(&ciphertext);
    write_private(&draft_path(directory, variant), &stored)
}

pub fn load(app: tauri::AppHandle, variant: String) -> Result<Option<String>, String> {
    let directory = app_data_dir(&app)?;
    load_from_directory(&directory, &variant)
}

pub fn backup(app: tauri::AppHandle, variant: String) -> Result<Option<String>, String> {
    let directory = app_data_dir(&app)?;
    backup_to_directory(&directory, &variant)
}

fn backup_to_directory(directory: &Path, variant: &str) -> Result<Option<String>, String> {
    let variant = safe_variant(variant)?;
    let _access = DRAFT_ACCESS
        .lock()
        .map_err(|_| "Резервне копіювання чернетки тимчасово недоступне.".to_string())?;
    let original_path = draft_path(directory, variant);
    if !original_path
        .try_exists()
        .map_err(|_| "Не вдалося перевірити чернетку для резервного копіювання.".to_string())?
    {
        return Ok(None);
    }
    let mut stored = Vec::new();
    File::open(&original_path)
        .and_then(|file| {
            file.take((MAX_STORED_SIZE + 1) as u64)
                .read_to_end(&mut stored)
        })
        .map_err(|_| "Не вдалося прочитати чернетку для резервного копіювання.".to_string())?;
    if stored.len() > MAX_STORED_SIZE {
        return Err("Збережена чернетка завелика для резервного копіювання.".into());
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Не вдалося визначити час резервного копіювання.".to_string())?
        .as_millis();
    let mut suffix = [0u8; 8];
    getrandom::getrandom(&mut suffix)
        .map_err(|_| "Не вдалося підготувати резервну копію чернетки.".to_string())?;
    let suffix = u64::from_le_bytes(suffix);
    let backup_path = directory.join(format!(
        "workspace-{variant}-{timestamp}-{suffix:016x}.bcsbackup"
    ));
    write_private(&backup_path, &stored)?;
    Ok(Some(backup_path.to_string_lossy().into_owned()))
}

fn load_from_directory(directory: &Path, variant: &str) -> Result<Option<String>, String> {
    let variant = safe_variant(variant)?;
    let _access = DRAFT_ACCESS
        .lock()
        .map_err(|_| "Читання чернетки тимчасово недоступне.".to_string())?;
    let path = draft_path(directory, variant);
    if !path
        .try_exists()
        .map_err(|_| "Не вдалося перевірити захищену чернетку.".to_string())?
    {
        return Ok(None);
    }

    let mut stored = Vec::new();
    File::open(path)
        .and_then(|file| {
            file.take((MAX_STORED_SIZE + 1) as u64)
                .read_to_end(&mut stored)
        })
        .map_err(|_| "Не вдалося прочитати захищену чернетку.".to_string())?;
    if stored.len() > MAX_STORED_SIZE
        || stored.len() < MAGIC.len() + NONCE_LENGTH + AUTHENTICATION_TAG_LENGTH
        || &stored[..MAGIC.len()] != MAGIC
    {
        return Err("Захищена чернетка пошкоджена.".into());
    }

    let key_bytes = load_key(directory)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce_start = MAGIC.len();
    let ciphertext_start = nonce_start + NONCE_LENGTH;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&stored[nonce_start..ciphertext_start]),
            Payload {
                msg: &stored[ciphertext_start..],
                aad: variant.as_bytes(),
            },
        )
        .map_err(|_| "Не вдалося розшифрувати чернетку.".to_string())?;
    let payload =
        String::from_utf8(plaintext).map_err(|_| "Захищена чернетка пошкоджена.".to_string())?;
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|_| "Захищена чернетка має неправильний формат.".to_string())?;
    Ok(Some(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn disk_round_trip_preserves_complete_editor_data_after_reload() {
        let directory = tempfile::tempdir().unwrap();
        let payload = json!({
            "version": 2,
            "unitName": "1 РУБАК",
            "reportDate": "2026-10-08",
            "authorizedCount": 78,
            "blocks": [{
                "id": "crew-1", "kind": "crew", "title": "СОКІЛ",
                "positionId": "position-1", "officialCount": 1, "actualCount": 3,
                "people": [{"id": "person-1", "rank": "солдат", "name": "ТЕСТЕНКО Іван Петрович", "location": "ПУ"}]
            }],
            "positions": [
                {"id": "position-1", "name": "ПОЗИЦІЯ СОКІЛ", "bro": "БРО 1", "sector": "ПІВНІЧ"},
                {"id": "position-unused", "name": "РЕЗЕРВ", "bro": "БРО 2", "sector": "ПІВДЕНЬ"}
            ]
        });
        let serialized = serde_json::to_string(&payload).unwrap();
        save_to_directory(directory.path(), "editor", &serialized).unwrap();
        let stored = fs::read(draft_path(directory.path(), "editor")).unwrap();
        assert!(stored.starts_with(MAGIC));
        assert!(!stored
            .windows("ТЕСТЕНКО".len())
            .any(|bytes| bytes == "ТЕСТЕНКО".as_bytes()));
        // The reader reconstructs everything from disk; no application state is shared.
        let reloaded = load_from_directory(directory.path(), "editor")
            .unwrap()
            .unwrap();
        assert_eq!(reloaded, serialized);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&reloaded).unwrap(),
            payload
        );
    }

    #[test]
    fn replacing_existing_draft_keeps_latest_payload_and_same_key() {
        let directory = tempfile::tempdir().unwrap();
        save_to_directory(
            directory.path(),
            "editor",
            r#"{"revision":1,"old":"value"}"#,
        )
        .unwrap();
        let key_path = directory.path().join(".bcs-draft.key");
        let original_key = fs::read(&key_path).unwrap();
        let newest = r#"{"revision":2,"positions":[{"id":"unused"}],"blocks":[]}"#;
        save_to_directory(directory.path(), "editor", newest).unwrap();
        assert_eq!(fs::read(&key_path).unwrap(), original_key);
        assert_eq!(
            load_from_directory(directory.path(), "editor")
                .unwrap()
                .as_deref(),
            Some(newest)
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn concurrent_saves_are_complete_and_final_save_wins() {
        let directory = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for revision in 0..12 {
                let path = directory.path();
                scope.spawn(move || {
                    let payload =
                        json!({"revision": revision, "people": ["ТЕСТЕНКО Іван"]}).to_string();
                    save_to_directory(path, "editor", &payload).unwrap();
                    let loaded = load_from_directory(path, "editor").unwrap().unwrap();
                    let loaded: serde_json::Value = serde_json::from_str(&loaded).unwrap();
                    assert!(loaded["revision"].as_u64().unwrap() < 12);
                    assert_eq!(loaded["people"], json!(["ТЕСТЕНКО Іван"]));
                });
            }
        });
        let final_payload = r#"{"revision":12,"complete":true}"#;
        save_to_directory(directory.path(), "editor", final_payload).unwrap();
        assert_eq!(
            load_from_directory(directory.path(), "editor")
                .unwrap()
                .as_deref(),
            Some(final_payload)
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn variants_keep_independent_encrypted_workspaces() {
        let directory = tempfile::tempdir().unwrap();
        for variant in ["editor", "template", "strips", "strips-registry"] {
            let payload = json!({"variant": variant}).to_string();
            save_to_directory(directory.path(), variant, &payload).unwrap();
        }
        for variant in ["editor", "template", "strips", "strips-registry"] {
            let payload = load_from_directory(directory.path(), variant)
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
                json!({"variant": variant})
            );
        }
    }

    #[test]
    fn missing_key_never_creates_new_key_or_overwrites_existing_draft() {
        let directory = tempfile::tempdir().unwrap();
        save_to_directory(directory.path(), "editor", r#"{"original":true}"#).unwrap();
        let path = draft_path(directory.path(), "editor");
        let original = fs::read(&path).unwrap();
        let key_path = directory.path().join(".bcs-draft.key");
        fs::remove_file(&key_path).unwrap();
        assert!(load_from_directory(directory.path(), "editor").is_err());
        assert!(save_to_directory(directory.path(), "editor", r#"{"replacement":true}"#).is_err());
        assert!(save_to_directory(directory.path(), "strips", r#"{"other":true}"#).is_err());
        assert!(!key_path.exists());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn empty_workspace_load_does_not_create_a_key_or_draft() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            load_from_directory(directory.path(), "editor").unwrap(),
            None
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn backup_keeps_original_encrypted_bytes_and_survives_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let payload = r#"{"original":true,"unitName":"ТЕСТОВИЙ ПІДРОЗДІЛ"}"#;
        save_to_directory(directory.path(), "editor", payload).unwrap();
        let original_path = draft_path(directory.path(), "editor");
        let original = fs::read(&original_path).unwrap();
        let backup_path = backup_to_directory(directory.path(), "editor")
            .unwrap()
            .unwrap();
        let backup_path = PathBuf::from(backup_path);
        assert_eq!(backup_path.extension().unwrap(), "bcsbackup");
        assert_eq!(fs::read(&backup_path).unwrap(), original);
        assert_eq!(fs::read(&original_path).unwrap(), original);
        save_to_directory(directory.path(), "editor", r#"{"replacement":true}"#).unwrap();
        assert_eq!(fs::read(&backup_path).unwrap(), original);
        let another_backup = backup_to_directory(directory.path(), "editor")
            .unwrap()
            .unwrap();
        assert_ne!(PathBuf::from(another_backup), backup_path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&backup_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn backup_of_empty_workspace_creates_no_files() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            backup_to_directory(directory.path(), "editor").unwrap(),
            None
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn oversized_stored_file_is_rejected_without_modifying_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = draft_path(directory.path(), "editor");
        let file = File::create(&path).unwrap();
        file.set_len((MAX_STORED_SIZE + 1) as u64).unwrap();
        assert!(load_from_directory(directory.path(), "editor").is_err());
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            (MAX_STORED_SIZE + 1) as u64
        );
        assert!(!directory.path().join(".bcs-draft.key").exists());
    }

    #[test]
    fn invalid_payload_and_failed_rename_preserve_previous_data() {
        let directory = tempfile::tempdir().unwrap();
        let payload = r#"{"original":true}"#;
        save_to_directory(directory.path(), "editor", payload).unwrap();
        let original = fs::read(draft_path(directory.path(), "editor")).unwrap();
        assert!(save_to_directory(directory.path(), "editor", "not JSON").is_err());
        assert_eq!(
            fs::read(draft_path(directory.path(), "editor")).unwrap(),
            original
        );
        let blocked_target = draft_path(directory.path(), "strips");
        fs::create_dir(&blocked_target).unwrap();
        assert!(save_to_directory(directory.path(), "strips", payload).is_err());
        assert!(blocked_target.is_dir());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
        assert_eq!(
            load_from_directory(directory.path(), "editor")
                .unwrap()
                .as_deref(),
            Some(payload)
        );
    }

    #[test]
    fn corrupted_draft_is_reported_without_modifying_disk() {
        let directory = tempfile::tempdir().unwrap();
        save_to_directory(directory.path(), "editor", r#"{"original":true}"#).unwrap();
        let path = draft_path(directory.path(), "editor");
        let mut stored = fs::read(&path).unwrap();
        let last = stored.len() - 1;
        stored[last] ^= 1;
        fs::write(&path, &stored).unwrap();
        assert!(load_from_directory(directory.path(), "editor").is_err());
        assert_eq!(fs::read(&path).unwrap(), stored);
    }

    #[test]
    fn existing_bcsdraft1_format_remains_readable() {
        let directory = tempfile::tempdir().unwrap();
        let key = [7u8; KEY_LENGTH];
        let nonce = [3u8; NONCE_LENGTH];
        let payload = r#"{"unitName":"СТАРА ЧЕРНЕТКА","blocks":[]}"#;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: payload.as_bytes(),
                    aad: b"editor",
                },
            )
            .unwrap();
        let stored = [MAGIC, &nonce, &ciphertext].concat();
        fs::write(directory.path().join(".bcs-draft.key"), key).unwrap();
        fs::write(draft_path(directory.path(), "editor"), stored).unwrap();
        assert_eq!(
            load_from_directory(directory.path(), "editor")
                .unwrap()
                .as_deref(),
            Some(payload)
        );
        save_to_directory(directory.path(), "editor", payload).unwrap();
        assert_eq!(
            load_from_directory(directory.path(), "editor")
                .unwrap()
                .as_deref(),
            Some(payload)
        );
    }

    #[cfg(unix)]
    #[test]
    fn key_and_draft_are_owner_read_write_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        save_to_directory(directory.path(), "editor", "{}").unwrap();
        let key_path = directory.path().join(".bcs-draft.key");
        for path in [&key_path, &draft_path(directory.path(), "editor")] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o644)).unwrap();
        load_from_directory(directory.path(), "editor").unwrap();
        assert_eq!(
            fs::metadata(key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn imported_editor_json_survives_actual_encrypted_disk_round_trip() {
        let Some(input_path) = std::env::var_os("BCSEDITOR_DRAFT_VERIFY_INPUT") else {
            return;
        };
        let payload = fs::read_to_string(input_path).unwrap();
        let directory = tempfile::tempdir().unwrap();
        save_to_directory(directory.path(), "editor", &payload).unwrap();
        let restored = load_from_directory(directory.path(), "editor")
            .unwrap()
            .unwrap();
        assert_eq!(restored, payload);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&restored).unwrap(),
            serde_json::from_str::<serde_json::Value>(&payload).unwrap()
        );
    }

    #[test]
    fn aes_round_trip_does_not_leave_plaintext() {
        let key_bytes = [7u8; KEY_LENGTH];
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
        let nonce_bytes = [3u8; NONCE_LENGTH];
        let plaintext = r#"{"unitName":"ТЕСТОВИЙ ПІДРОЗДІЛ"}"#.as_bytes();
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: b"editor",
                },
            )
            .unwrap();
        assert!(!encrypted
            .windows("ТЕСТОВИЙ ПІДРОЗДІЛ".len())
            .any(|value| value == "ТЕСТОВИЙ ПІДРОЗДІЛ".as_bytes()));
        let decrypted = cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &encrypted,
                    aad: b"editor",
                },
            )
            .unwrap();
        assert_eq!(decrypted, plaintext);
    }
}
