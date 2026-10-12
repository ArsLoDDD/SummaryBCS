param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PATH)) {
    throw "WINDOWS_CERTIFICATE_PATH is not set. Unsigned Windows builds are forbidden."
}

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) {
    throw "WINDOWS_CERTIFICATE_PASSWORD is not set. Unsigned Windows builds are forbidden."
}

$certificatePath = (Resolve-Path -LiteralPath $env:WINDOWS_CERTIFICATE_PATH).Path
$targetPath = (Resolve-Path -LiteralPath $FilePath).Path
$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_TIMESTAMP_URL)) {
    "http://timestamp.digicert.com"
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
        throw "signtool.exe was not found. Install the Windows SDK Signing Tools."
    }
    $signToolPath = $signTool.FullName
}

& $signToolPath sign `
    /fd SHA256 `
    /f $certificatePath `
    /p $env:WINDOWS_CERTIFICATE_PASSWORD `
    /v `
    $targetPath

if ($LASTEXITCODE -ne 0) {
    throw "SignTool failed to sign the file: $targetPath"
}

$timestampUrls = @($timestampUrl, "http://timestamp.digicert.com") | Select-Object -Unique
$timestampSucceeded = $false
foreach ($activeTimestampUrl in $timestampUrls) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        & $signToolPath timestamp `
            /tr $activeTimestampUrl `
            /td SHA256 `
            /v `
            $targetPath
        if ($LASTEXITCODE -eq 0) {
            $timestampSucceeded = $true
            break
        }
        if ($attempt -lt 3) {
            Start-Sleep -Seconds 2
        }
    }
    if ($timestampSucceeded) {
        break
    }
}

if (-not $timestampSucceeded) {
    throw "SignTool failed to timestamp the file: $targetPath"
}

& $signToolPath verify /pa /all /v $targetPath
$verificationExitCode = $LASTEXITCODE
$selfSignedMode = $env:WINDOWS_SIGNING_MODE -eq "self-signed"
if ($verificationExitCode -ne 0 -and -not $selfSignedMode) {
    throw "The signature was created, but trust verification failed: $targetPath"
}

$signature = Get-AuthenticodeSignature -FilePath $targetPath
$selfSignedStatusAllowed = $selfSignedMode -and ($signature.Status.ToString() -in @("NotTrusted", "UnknownError"))
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -and -not $selfSignedStatusAllowed) {
    throw "Windows does not consider the signature valid ($($signature.Status)): $targetPath"
}

if ($null -eq $signature.SignerCertificate) {
    throw "The file does not contain a signer certificate: $targetPath"
}

$expectedCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $certificatePath,
    $env:WINDOWS_CERTIFICATE_PASSWORD,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
)
if ($signature.SignerCertificate.Thumbprint -ne $expectedCertificate.Thumbprint) {
    throw "The file was not signed with the prepared certificate: $targetPath"
}

if ($null -eq $signature.TimeStamperCertificate) {
    throw "The signature does not contain a timestamp: $targetPath"
}

if ($selfSignedMode -and $verificationExitCode -ne 0) {
    Write-Warning "The cryptographic signature and thumbprint are valid. Trust is enabled after installing the bundled CER file."
}

