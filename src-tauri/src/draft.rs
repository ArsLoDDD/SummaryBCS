use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAGIC: &[u8] = b"BCSDRAFT1";
const KEY_LENGTH: usize = 32;
const NONCE_LENGTH: usize = 12;
const MAX_DRAFT_SIZE: usize = 20 * 1024 * 1024;

fn safe_variant(variant: &str) -> Result<&str, String> {
    match variant {
        "template" | "editor" => Ok(variant),
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
    options.write(true).create(true).truncate(true).mode(0o600);
    options
}

#[cfg(not(unix))]
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    options
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let mut file = private_options()
        .open(&temporary)
        .map_err(|_| "Не вдалося записати захищену чернетку.".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Не вдалося записати захищену чернетку.".to_string())?;
    fs::rename(&temporary, path).map_err(|_| "Не вдалося оновити захищену чернетку.".to_string())
}

fn load_or_create_key(directory: &Path) -> Result<[u8; KEY_LENGTH], String> {
    let path = directory.join(".bcs-draft.key");
    if path.exists() {
        let mut bytes = Vec::new();
        File::open(&path)
            .and_then(|mut file| file.read_to_end(&mut bytes))
            .map_err(|_| "Не вдалося прочитати ключ чернетки.".to_string())?;
        return bytes
            .try_into()
            .map_err(|_| "Ключ чернетки пошкоджений.".to_string());
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
    let variant = safe_variant(&variant)?;
    if payload.len() > MAX_DRAFT_SIZE {
        return Err("Чернетка завелика для автоматичного збереження.".into());
    }
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|_| "Чернетка має неправильний формат.".to_string())?;

    let directory = app_data_dir(&app)?;
    let key_bytes = load_or_create_key(&directory)?;
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
    write_private(&draft_path(&directory, variant), &stored)
}

pub fn load(app: tauri::AppHandle, variant: String) -> Result<Option<String>, String> {
    let variant = safe_variant(&variant)?;
    let directory = app_data_dir(&app)?;
    let path = draft_path(&directory, variant);
    if !path.exists() {
        return Ok(None);
    }

    let mut stored = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut stored))
        .map_err(|_| "Не вдалося прочитати захищену чернетку.".to_string())?;
    if stored.len() < MAGIC.len() + NONCE_LENGTH || &stored[..MAGIC.len()] != MAGIC {
        return Err("Захищена чернетка пошкоджена.".into());
    }

    let key_bytes = load_or_create_key(&directory)?;
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
    Ok(Some(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

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
