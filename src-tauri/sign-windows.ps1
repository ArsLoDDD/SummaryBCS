param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PATH)) {
    throw "WINDOWS_CERTIFICATE_PATH не задано. Непідписана Windows-збірка заборонена."
}

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) {
    throw "WINDOWS_CERTIFICATE_PASSWORD не задано. Непідписана Windows-збірка заборонена."
}

$certificatePath = (Resolve-Path -LiteralPath $env:WINDOWS_CERTIFICATE_PATH).Path
$targetPath = (Resolve-Path -LiteralPath $FilePath).Path
$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_TIMESTAMP_URL)) {
    "https://timestamp.digicert.com"
} else {
    $env:WINDOWS_TIMESTAMP_URL
}

$signToolCommand = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
if ($null -ne $signToolCommand) {
    $signToolPath = $signToolCommand.Source
} else {
    $windowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $signTool = Get-ChildItem -Path $windowsKitsRoot -Filter "signtool.exe" -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq "x64" } |
        Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
        Select-Object -First 1

    if ($null -eq $signTool) {
        throw "signtool.exe не знайдено. Встановіть Windows SDK із Signing Tools."
    }
    $signToolPath = $signTool.FullName
}

& $signToolPath sign `
    /fd SHA256 `
    /tr $timestampUrl `
    /td SHA256 `
    /f $certificatePath `
    /p $env:WINDOWS_CERTIFICATE_PASSWORD `
    /v `
    $targetPath

if ($LASTEXITCODE -ne 0) {
    throw "SignTool не зміг підписати файл: $targetPath"
}

& $signToolPath verify /pa /all /v $targetPath
$verificationExitCode = $LASTEXITCODE
$selfSignedMode = $env:WINDOWS_SIGNING_MODE -eq "self-signed"
if ($verificationExitCode -ne 0 -and -not $selfSignedMode) {
    throw "Підпис створено, але перевірка довіри не пройдена: $targetPath"
}

$signature = Get-AuthenticodeSignature -FilePath $targetPath
$selfSignedStatusAllowed = $selfSignedMode -and ($signature.Status.ToString() -in @("NotTrusted", "UnknownError"))
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -and -not $selfSignedStatusAllowed) {
    throw "Windows не вважає підпис чинним ($($signature.Status)): $targetPath"
}

if ($null -eq $signature.SignerCertificate) {
    throw "У файлі відсутній сертифікат підписувача: $targetPath"
}

$expectedCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $certificatePath,
    $env:WINDOWS_CERTIFICATE_PASSWORD,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
)
if ($signature.SignerCertificate.Thumbprint -ne $expectedCertificate.Thumbprint) {
    throw "Файл підписаний не підготовленим сертифікатом: $targetPath"
}

if ($null -eq $signature.TimeStamperCertificate) {
    throw "У підписі немає мітки часу: $targetPath"
}

if ($selfSignedMode -and $verificationExitCode -ne 0) {
    Write-Warning "Криптографічний підпис і відбиток перевірені; довіра з'явиться після встановлення вкладеного CER."
}

