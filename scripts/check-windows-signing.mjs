import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDirectory = path.join(projectRoot, "src-tauri");
const baseConfig = JSON.parse(await readFile(path.join(tauriDirectory, "tauri.conf.json"), "utf8"));
const signingScript = await readFile(path.join(tauriDirectory, "sign-windows.ps1"), "utf8");
const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "build-windows.yml"), "utf8");
const signCommand = baseConfig?.bundle?.windows?.signCommand;

// A GUI EXE has subsystem 2 in both PE32 and PE32+ optional headers.
// Check the actual built file in CI, not just the source attribute.
function assertGuiExecutable(bytes, label) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${label}: відсутній заголовок Windows EXE.`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 24 + 70 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x4550) {
    throw new Error(`${label}: пошкоджений PE-заголовок.`);
  }
  const optionalHeader = peOffset + 24;
  const headerSize = bytes.readUInt16LE(peOffset + 20);
  if (headerSize < 70 || optionalHeader + headerSize > bytes.length
    || ![0x10b, 0x20b].includes(bytes.readUInt16LE(optionalHeader))) {
    throw new Error(`${label}: невідомий формат PE-заголовка.`);
  }
  if (bytes.readUInt16LE(optionalHeader + 68) !== 2) {
    throw new Error(`${label}: EXE має консольний підтип замість Windows GUI та може відкривати CMD.`);
  }
}

function testGuiExecutableCheck() {
  const sample = (magic, subsystem) => {
    const bytes = Buffer.alloc(512);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(128, 0x3c);
    bytes.writeUInt32LE(0x4550, 128);
    bytes.writeUInt16LE(240, 148);
    bytes.writeUInt16LE(magic, 152);
    bytes.writeUInt16LE(subsystem, 220);
    return bytes;
  };
  for (const magic of [0x10b, 0x20b]) {
    assertGuiExecutable(sample(magic, 2), "test GUI");
    let rejected = false;
    try { assertGuiExecutable(sample(magic, 3), "test console"); } catch { rejected = true; }
    if (!rejected) throw new Error("Перевірка Windows EXE пропустила консольну програму.");
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(512), sample(0x1234, 2)]) {
    let rejected = false;
    try { assertGuiExecutable(bytes, "test invalid"); } catch { rejected = true; }
    if (!rejected) throw new Error("Перевірка Windows EXE пропустила невалідний файл.");
  }
}

function fail(message) {
  console.error(`Windows signing policy: ${message}`);
  process.exitCode = 1;
}

testGuiExecutableCheck();
const cargoManifest = await readFile(path.join(tauriDirectory, "Cargo.toml"), "utf8");
const rustEntries = new Set([path.join(tauriDirectory, "src", "main.rs")]);
for (const block of cargoManifest.split(/\[\[bin\]\]/).slice(1)) {
  const explicitPath = /^\s*path\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  if (explicitPath) rustEntries.add(path.resolve(tauriDirectory, explicitPath));
}
async function discoverBinaries(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await discoverBinaries(file);
    else if (entry.name.endsWith(".rs")) rustEntries.add(file);
  }
}
await discoverBinaries(path.join(tauriDirectory, "src", "bin"));
for (const entry of rustEntries) {
  const source = await readFile(entry, "utf8");
  if (/\bfn\s+main\s*\(/.test(source)
    && !/^#!\s*\[\s*cfg_attr\(\s*(?:target_os\s*=\s*"windows"|windows)\s*,\s*windows_subsystem\s*=\s*"windows"\s*\)\s*\]/m.test(source)) {
    fail(`${path.relative(projectRoot, entry)} повинен використовувати Windows GUI subsystem у release і debug, щоб не відкривати CMD.`);
  }
}
for (let index = 2; index < process.argv.length; index += 2) {
  if (process.argv[index] !== "--exe" || !process.argv[index + 1]) {
    fail("перевірка EXE очікує --exe <шлях>.");
    break;
  }
  const file = process.argv[index + 1];
  try {
    assertGuiExecutable(await readFile(file), path.basename(file));
    console.log(`Windows GUI subsystem: OK (${path.basename(file)}).`);
  } catch (error) {
    fail(error.message);
  }
}

if (signCommand?.cmd !== "powershell.exe") {
  fail("у базовій конфігурації Tauri має бути обов’язкова команда powershell.exe для підпису.");
}

const args = Array.isArray(signCommand?.args) ? signCommand.args : [];
if (!args.some((arg) => arg.endsWith("src-tauri/sign-windows.ps1")) || !args.includes("%1")) {
  fail("команда підпису має викликати sign-windows.ps1 і передавати шлях через %1.");
}

if (/[^\x00-\x7F]/.test(signingScript)) {
  fail("sign-windows.ps1 має містити лише ASCII, щоб Windows PowerShell 5.1 не пошкоджував UTF-8 без BOM.");
}

for (const requiredFragment of [
  "/fd SHA256",
  "timestamp `",
  "/tr $activeTimestampUrl",
  "/td SHA256",
  "http://timestamp.digicert.com",
  "$attempt -le 3",
  "verify /pa /all",
  "TimeStamperCertificate",
]) {
  if (!signingScript.includes(requiredFragment)) {
    fail(`sign-windows.ps1 втратив обов’язкове правило: ${requiredFragment}.`);
  }
}

for (const requiredFragment of [
  "New-SelfSignedCertificate",
  "-Type CodeSigningCert",
  "Export-PfxCertificate",
  "Export-Certificate",
  "SummaryBCS-Code-Signing.cer",
  "WINDOWS_SIGNING_MODE=$signingMode",
  "SignerCertificate.Thumbprint -ne $expectedCertificate.Thumbprint",
  "Перевірити підпис до основної збірки",
  "scripts/signing-probe.rs",
  "compile_command: npm run tauri -- build --no-bundle --no-sign",
  "--bundles nsis --no-sign --no-binary-patching",
  "Підписати програму ${{ matrix.app }}",
  "Підписати інсталятор і підготувати EXE",
  "-File $signingScript",
  "path: windows-artifact/*",
  "Перевірити EXE без консольного вікна",
  "node scripts/check-windows-signing.mjs --exe",
]) {
  if (!workflow.includes(requiredFragment)) {
    fail(`Windows workflow втратив резервне самопідписування: ${requiredFragment}.`);
  }
}

if (workflow.includes("Import-Certificate")) {
  fail("workflow не повинен імпортувати самопідписаний сертифікат у системне сховище: це може зависнути на прихованому діалозі Windows.");
}

if (!/push:\s*\n\s*branches:\s*\n\s*-\s*main\b/.test(workflow) || !workflow.includes("workflow_dispatch:")) {
  fail("Windows-збірка має запускатися після push у main та вручну.");
}
if (workflow.includes("tauri.template.conf.json") || workflow.includes("BCSTemplateBuilder")) {
  fail("варіант «Шаблон» поки не повинен входити до Windows matrix.");
}

const configNames = (await readdir(tauriDirectory))
  .filter((name) => /^tauri(?:\.[^.]+)?\.conf\.json$/.test(name) && name !== "tauri.conf.json");

for (const configName of configNames) {
  const config = JSON.parse(await readFile(path.join(tauriDirectory, configName), "utf8"));
  if (Object.hasOwn(config?.bundle?.windows ?? {}, "signCommand")) {
    fail(`${configName} не повинен перевизначати спільну команду підпису.`);
  }
}

if (!process.exitCode) {
  console.log(`Windows GUI policy: OK (${rustEntries.size} Rust entry points, 7 PE-header regression checks).`);
  console.log(`Windows signing policy: OK (${configNames.length + 1} Tauri-конфігурації).`);
}

