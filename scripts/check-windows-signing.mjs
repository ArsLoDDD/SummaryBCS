import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDirectory = path.join(projectRoot, "src-tauri");
const baseConfig = JSON.parse(await readFile(path.join(tauriDirectory, "tauri.conf.json"), "utf8"));
const signingScript = await readFile(path.join(tauriDirectory, "sign-windows.ps1"), "utf8");
const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "build-windows.yml"), "utf8");
const signCommand = baseConfig?.bundle?.windows?.signCommand;

function fail(message) {
  console.error(`Windows signing policy: ${message}`);
  process.exitCode = 1;
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
  "/tr $timestampUrl",
  "/td SHA256",
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
  "path: windows-artifact/*",
]) {
  if (!workflow.includes(requiredFragment)) {
    fail(`Windows workflow втратив резервне самопідписування: ${requiredFragment}.`);
  }
}

if (workflow.includes("Import-Certificate")) {
  fail("workflow не повинен імпортувати самопідписаний сертифікат у системне сховище: це може зависнути на прихованому діалозі Windows.");
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
  console.log(`Windows signing policy: OK (${configNames.length + 1} Tauri-конфігурації).`);
}

