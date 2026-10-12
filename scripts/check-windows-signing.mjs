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
if (!args.includes("sign-windows.ps1") || !args.includes("%1")) {
  fail("команда підпису має викликати sign-windows.ps1 і передавати шлях через %1.");
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
  "Cert:\\CurrentUser\\Root",
  "Cert:\\CurrentUser\\TrustedPublisher",
  "path: windows-artifact/*",
]) {
  if (!workflow.includes(requiredFragment)) {
    fail(`Windows workflow втратив резервне самопідписування: ${requiredFragment}.`);
  }
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

