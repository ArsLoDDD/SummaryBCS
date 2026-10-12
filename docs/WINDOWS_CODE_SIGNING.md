# Підпис Windows-програм

Усі Windows-програми цього репозиторію підписуються однією обов’язковою командою з базової конфігурації Tauri. Вона успадковується «Зведенням БЧС», «Редактором БЧС», «Редактором позицій по смугах» і всіма майбутніми варіантами, які додаються через окрему Tauri-конфігурацію.

Непідписаний інсталятор не завантажується в артефакти GitHub Actions. Якщо корпоративний або публічно довірений PFX не налаштований, workflow автоматично створює резервний самопідписаний сертифікат Windows Code Signing. Ним підписуються і файл програми, і NSIS-інсталятор.

Кожен ZIP-артефакт містить:

- підписаний NSIS `.exe`;
- `SummaryBCS-Code-Signing.cer` — лише відкриту частину сертифіката;
- `INSTALL-CERTIFICATE.txt` — просту інструкцію встановлення довіри;
- `SIGNING-INFO.txt` — тип підпису, відбиток і строк чинності.

## Який сертифікат потрібний

Потрібен саме сертифікат **Windows Code Signing** із приватним ключем у форматі `.pfx`:

- сертифікат публічного центру сертифікації; або
- сертифікат внутрішнього центру сертифікації організації, кореневому сертифікату якого вже довіряють усі робочі ПК.

Ця реалізація розрахована на сертифікат, який організація дозволяє експортувати у `.pfx`. Якщо постачальник зберігає ключ лише на апаратному токені або в хмарному HSM, `signCommand` потрібно замінити на офіційний інструмент цього постачальника; приватний ключ усе одно не можна експортувати чи додавати до репозиторію.

Самопідписаний сертифікат стає довіреним лише після встановлення вкладеного `.cer` у сховища `Trusted Root Certification Authorities` і `Trusted Publishers` на робочому ПК. Це має зробити користувач або ІТ-служба. До встановлення сертифіката Windows може показувати попередження. Звичайний SSL/TLS-сертифікат для цього не підходить.

Приватний ключ і пароль не можна додавати до Git, ZIP-артефактів або передавати разом з інсталятором.

## GitHub Secrets

Для постійного корпоративного або публічно довіреного підпису в налаштуваннях репозиторію потрібно створити два секрети:

- `WINDOWS_CERTIFICATE` — Base64-вміст файлу `.pfx`;
- `WINDOWS_CERTIFICATE_PASSWORD` — пароль цього `.pfx`.

Отримати Base64 у PowerShell можна так:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secure\code-signing.pfx")) |
    Set-Content -NoNewline "C:\secure\code-signing-base64.txt"
```

Вміст `code-signing-base64.txt` додається до `WINDOWS_CERTIFICATE`. Самі файли після цього залишаються лише у захищеному сховищі відповідальної особи або ІТ-служби. Якщо обидва секрети відсутні, збірка не зупиняється: створюється тимчасовий самопідписаний сертифікат. Якщо заданий лише один із двох секретів, збірка завершується помилкою, щоб не приховувати неправильне налаштування.

## Самопідписаний резервний режим

Для кожного ZIP-артефакту GitHub Actions створює і додає публічний файл `SummaryBCS-Code-Signing.cer`. Приватний ключ існує лише під час збірки, не потрапляє до ZIP і видаляється після завершення job.

Щоб Windows визнавала підпис довіреним, виконайте від імені адміністратора в розпакованій папці:

```powershell
Import-Certificate -FilePath ".\SummaryBCS-Code-Signing.cer" -CertStoreLocation "Cert:\LocalMachine\Root"
Import-Certificate -FilePath ".\SummaryBCS-Code-Signing.cer" -CertStoreLocation "Cert:\LocalMachine\TrustedPublisher"
```

Оскільки резервний сертифікат створюється окремо в кожному matrix-job, сертифікат із кожного з трьох ZIP потрібно встановити окремо. Для одного постійного сертифіката в усіх версіях слід налаштувати GitHub Secrets із контрольованим PFX.

## Локальна підписана збірка на Windows

```powershell
$env:WINDOWS_CERTIFICATE_PATH = "C:\secure\code-signing.pfx"
$env:WINDOWS_CERTIFICATE_PASSWORD = "пароль-pfx"
$env:WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com"

npm run tauri:build:summary
npm run tauri:build:editor
npm run tauri:build:strips

Remove-Item Env:WINDOWS_CERTIFICATE_PATH
Remove-Item Env:WINDOWS_CERTIFICATE_PASSWORD
Remove-Item Env:WINDOWS_TIMESTAMP_URL
```

## Перевірка готового EXE

```powershell
Get-AuthenticodeSignature "C:\path\program-setup.exe" |
    Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

`Status` має бути `Valid`, а `TimeStamperCertificate` не повинен бути порожнім.

## Додавання майбутньої програми

1. Створити окрему додаткову `tauri.<назва>.conf.json`, яка успадковує базову `tauri.conf.json`.
2. Не перевизначати `bundle.windows.signCommand`.
3. Додати програму до матриці `.github/workflows/build-windows.yml`.
4. Залишити фінальну перевірку Authenticode увімкненою.

Команда `npm run check:signing` перевіряє це правило автоматично в кожному CI-запуску.
