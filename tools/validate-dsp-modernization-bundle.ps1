param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDir,

    [string]$ReportPath = "",

    [switch]$AllowPreflight,

    [switch]$JsonOnly
)

$ErrorActionPreference = "Stop"

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        throw "Failed to parse JSON file '$Path': $($_.Exception.Message)"
    }
}

function Add-ValidationIssue {
    param(
        [System.Collections.Generic.List[object]]$Target,
        [Parameter(Mandatory = $true)][string]$Severity,
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $Target.Add([ordered]@{
        severity = $Severity
        code = $Code
        message = $Message
    }) | Out-Null
}

function Add-AcceptanceIssue {
    param(
        [System.Collections.Generic.List[object]]$Errors,
        [System.Collections.Generic.List[object]]$Warnings,
        [switch]$AllowPreflight,
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ($AllowPreflight) {
        Add-ValidationIssue $Warnings "warning" $Code $Message
    }
    else {
        Add-ValidationIssue $Errors "error" $Code $Message
    }
}

function Get-EndpointById {
    param(
        [Parameter(Mandatory = $true)]$Index,
        [Parameter(Mandatory = $true)][string]$Id
    )

    foreach ($endpoint in @($Index.endpoints)) {
        if ($endpoint.id -eq $Id) {
            return $endpoint
        }
    }
    return $null
}

function Get-JsonValue {
    param(
        $Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Get-JsonArray {
    param(
        $Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $value = Get-JsonValue $Object $Name
    if ($null -eq $value) {
        return @()
    }

    if ($value -is [System.Array]) {
        return @($value)
    }

    return @($value)
}

function Test-Truthy {
    param($Value)

    if ($null -eq $Value) {
        return $false
    }

    if ($Value -is [bool]) {
        return $Value
    }

    return [bool]$Value
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 32
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

$bundlePath = (Resolve-Path -LiteralPath $BundleDir).Path
$indexPath = Join-Path $bundlePath "bundle-index.json"
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw "DSP modernization bundle is missing bundle-index.json: $bundlePath"
}

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path $bundlePath "validation-report.json"
}

$index = Read-JsonFile $indexPath
$errors = New-Object System.Collections.Generic.List[object]
$warnings = New-Object System.Collections.Generic.List[object]
$parsedFiles = @{}

foreach ($endpoint in (Get-JsonArray $index "endpoints")) {
    $id = [string]$endpoint.id
    $file = [string]$endpoint.file
    $required = Test-Truthy $endpoint.required
    $ok = Test-Truthy $endpoint.ok

    if ([string]::IsNullOrWhiteSpace($id)) {
        Add-ValidationIssue $errors "error" "endpoint-id-missing" "Bundle index contains an endpoint entry with no id."
        continue
    }

    if ($required -and -not $ok) {
        Add-ValidationIssue $errors "error" "required-endpoint-failed" "Required endpoint '$id' failed during capture."
    }
    elseif (-not $required -and -not $ok) {
        Add-ValidationIssue $warnings "warning" "optional-endpoint-failed" "Optional endpoint '$id' failed during capture."
    }

    if ([string]::IsNullOrWhiteSpace($file)) {
        if ($required) {
            Add-ValidationIssue $errors "error" "endpoint-file-missing" "Required endpoint '$id' does not declare an output file."
        }
        continue
    }

    $path = Join-Path $bundlePath $file
    if ($ok -and -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Add-ValidationIssue $errors "error" "captured-file-missing" "Endpoint '$id' is marked ok but file '$file' is missing."
        continue
    }

    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $length = (Get-Item -LiteralPath $path).Length
        if ($length -le 0) {
            Add-ValidationIssue $errors "error" "captured-file-empty" "Captured file '$file' is empty."
            continue
        }

        try {
            $parsedFiles[$id] = Read-JsonFile $path
        }
        catch {
            Add-ValidationIssue $errors "error" "captured-json-invalid" $_.Exception.Message
        }
    }
}

foreach ($failure in (Get-JsonArray $index "requiredFailures")) {
    if (-not [string]::IsNullOrWhiteSpace([string]$failure)) {
        Add-ValidationIssue $errors "error" "bundle-required-failure" "Bundle index reports required endpoint failure: $failure."
    }
}

$snapshot = $parsedFiles["modernization-snapshot"]
$live = $parsedFiles["live-diagnostics"]
$manifest = $parsedFiles["benchmark-capture-manifest"]
$plan = $parsedFiles["benchmark-plan"]

if ($null -eq $snapshot) {
    Add-ValidationIssue $errors "error" "snapshot-missing" "modernization-snapshot.json is required for acceptance review."
}
else {
    $score = Get-JsonValue $snapshot "evidenceCompletenessScore"
    $readyCapture = Test-Truthy (Get-JsonValue $snapshot "readyForCapture")
    $readyLive = Test-Truthy (Get-JsonValue $snapshot "readyForLiveBenchmark")
    $missingEvidence = Get-JsonArray $snapshot "missingEvidence"

    if ($null -eq $score -or [int]$score -lt 0 -or [int]$score -gt 100) {
        Add-ValidationIssue $errors "error" "snapshot-score-invalid" "Modernization snapshot evidenceCompletenessScore must be 0..100."
    }
    elseif ([int]$score -lt 90) {
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "snapshot-score-low" "Modernization snapshot evidenceCompletenessScore is $score; acceptance evidence requires at least 90."
    }

    if (-not $readyLive) {
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "live-benchmark-not-ready" "Snapshot is not ready for live benchmark capture."
    }

    if (-not $readyCapture) {
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "capture-not-ready" "Snapshot is not ready for capture acceptance."
    }

    if ($missingEvidence.Count -gt 0) {
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "snapshot-missing-evidence" "Snapshot reports missing evidence: $($missingEvidence -join ', ')."
    }
}

if ($null -eq $live) {
    Add-ValidationIssue $errors "error" "live-diagnostics-missing" "live-diagnostics.json is required."
}
else {
    $rolloutGate = [string](Get-JsonValue $live "rolloutGate")
    if ($rolloutGate -notlike "*opt-in*") {
        Add-ValidationIssue $errors "error" "rollout-gate-not-opt-in" "Live diagnostics rollout gate must remain opt-in until acceptance evidence passes."
    }
}

if ($null -eq $manifest) {
    Add-ValidationIssue $errors "error" "capture-manifest-missing" "benchmark-capture-manifest.json is required."
}
else {
    $requiredArtifacts = Get-JsonArray $manifest "requiredArtifacts"
    if ($requiredArtifacts.Count -eq 0) {
        Add-ValidationIssue $errors "error" "manifest-artifacts-missing" "Capture manifest does not list required artifacts."
    }

    $artifactIds = @{}
    foreach ($artifact in $requiredArtifacts) {
        $artifactId = [string](Get-JsonValue $artifact "id")
        if (-not [string]::IsNullOrWhiteSpace($artifactId)) {
            $artifactIds[$artifactId] = $true
        }
    }

    foreach ($requiredArtifact in @("live-diagnostics-json", "benchmark-plan-json", "offline-fixture-metrics")) {
        if (-not $artifactIds.ContainsKey($requiredArtifact)) {
            Add-ValidationIssue $errors "error" "manifest-required-artifact-missing" "Capture manifest is missing required artifact '$requiredArtifact'."
        }
    }
}

if ($null -eq $plan) {
    Add-ValidationIssue $errors "error" "benchmark-plan-missing" "benchmark-plan.json is required."
}
else {
    $globalGates = Get-JsonArray $plan "globalAcceptanceGates"
    $gateText = $globalGates -join " "
    if ($gateText -notlike "*No weak-signal loss*" -or $gateText -notlike "*No TX clipping*") {
        Add-ValidationIssue $errors "error" "benchmark-gates-incomplete" "Benchmark plan must include weak-signal and TX clipping acceptance gates."
    }
}

$ok = ($errors.Count -eq 0)
$report = [ordered]@{
    schemaVersion = 1
    tool = "validate-dsp-modernization-bundle"
    generatedUtc = [DateTimeOffset]::UtcNow
    bundleDir = $bundlePath
    ok = $ok
    allowPreflight = [bool]$AllowPreflight
    errorCount = $errors.Count
    warningCount = $warnings.Count
    errors = @($errors.ToArray())
    warnings = @($warnings.ToArray())
}

Write-JsonFile -Path $ReportPath -Value $report

if ($JsonOnly) {
    $report | ConvertTo-Json -Depth 32
}
else {
    if ($ok) {
        Write-Host "DSP modernization bundle validation passed: $bundlePath"
    }
    else {
        Write-Host "DSP modernization bundle validation failed: $bundlePath"
    }
    Write-Host "Report: $ReportPath"
    Write-Host "Errors: $($errors.Count), Warnings: $($warnings.Count)"
}

if (-not $ok) {
    exit 1
}
