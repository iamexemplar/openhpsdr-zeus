param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDir,

    [string]$ReportPath = "",

    [switch]$AllowPreflight,

    [string]$ArtifactManifestPath = "",

    [switch]$RequireArtifactFiles,

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

function Add-ArtifactIssue {
    param(
        [System.Collections.Generic.List[object]]$Errors,
        [System.Collections.Generic.List[object]]$Warnings,
        [Parameter(Mandatory = $true)][bool]$Required,
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ($Required) {
        Add-ValidationIssue $Errors "error" $Code $Message
    }
    else {
        Add-ValidationIssue $Warnings "warning" $Code $Message
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

function ConvertTo-HardwareId {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    return ($Value.Trim().ToLowerInvariant() -replace "[^a-z0-9]+", "")
}

function Test-G2BenchmarkTarget {
    param([string]$Value)

    return (ConvertTo-HardwareId $Value) -eq "g2"
}

function Test-OrionMkIIBoard {
    param([string]$Value)

    return (ConvertTo-HardwareId $Value) -eq "orionmkii"
}

function Test-G2Variant {
    param([string]$Value)

    $id = ConvertTo-HardwareId $Value
    return ($id -eq "g2" -or $id -eq "g21k")
}

function Get-HardwareDiagnosticField {
    param(
        $Hardware,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $value = Get-JsonValue $Hardware $Name
    if ($null -ne $value) {
        return $value
    }

    $potential = Get-JsonValue $Hardware "hardwarePotential"
    if ($null -ne $potential) {
        return Get-JsonValue $potential $Name
    }

    return $null
}

function Get-BundlePath {
    param(
        [Parameter(Mandatory = $true)][string]$BundlePath,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return Join-Path $BundlePath $Path
}

function Test-JsonArtifact {
    param(
        [string]$Kind,
        [string]$Path
    )

    $extension = [System.IO.Path]::GetExtension($Path)
    if (Test-JsonlArtifact $Kind $Path) {
        return $false
    }

    return ($Kind -match "json" -or $extension -ieq ".json")
}

function Test-JsonlArtifact {
    param(
        [string]$Kind,
        [string]$Path
    )

    $extension = [System.IO.Path]::GetExtension($Path)
    return ($Kind -match "jsonl" -or $extension -ieq ".jsonl")
}

function Test-JsonlFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $lineNumber = 0
    $recordCount = 0
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $lineNumber++
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $null = $line | ConvertFrom-Json
            $recordCount++
        }
        catch {
            throw "Failed to parse JSONL file '$Path' at line ${lineNumber}: $($_.Exception.Message)"
        }
    }

    return $recordCount
}

function Test-ArtifactIndex {
    param(
        [string]$Kind,
        [string]$Path
    )

    $extension = [System.IO.Path]::GetExtension($Path)
    return (($Kind -match "audio|spectrum|trace") -and $extension -ieq ".json")
}

function Get-ArtifactIndexFilePath {
    param($FileEntry)

    if ($FileEntry -is [string]) {
        return [string]$FileEntry
    }

    return [string](Get-JsonValue $FileEntry "path")
}

function Get-ArtifactIndexFileScenarioIds {
    param($FileEntry)

    if ($FileEntry -is [string]) {
        return @()
    }

    $scenarioIds = New-Object System.Collections.Generic.List[string]
    $scenarioId = [string](Get-JsonValue $FileEntry "scenarioId")
    if (-not [string]::IsNullOrWhiteSpace($scenarioId)) {
        $scenarioIds.Add($scenarioId) | Out-Null
    }

    foreach ($value in (Get-JsonArray $FileEntry "scenarioIds")) {
        $scenario = [string]$value
        if (-not [string]::IsNullOrWhiteSpace($scenario)) {
            $scenarioIds.Add($scenario) | Out-Null
        }
    }

    return @($scenarioIds.ToArray() | Select-Object -Unique)
}

function ConvertTo-ComparisonId {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $normalized = $Value.Trim().ToLowerInvariant() -replace "[^a-z0-9]+", "-"
    $normalized = $normalized.Trim("-")

    switch ($normalized) {
        "off" { return "off-baseline" }
        "baseline" { return "off-baseline" }
        "off-baseline" { return "off-baseline" }
        "thetis" { return "thetis-parity" }
        "thetis-parity" { return "thetis-parity" }
        "current" { return "current-zeus" }
        "current-zeus" { return "current-zeus" }
        "zeus-current" { return "current-zeus" }
        "zeus" { return "current-zeus" }
        "nr5" { return "nr5-spnr" }
        "spnr" { return "nr5-spnr" }
        "nr5-spnr" { return "nr5-spnr" }
        "candidate" { return "candidate-under-test" }
        "candidate-under-test" { return "candidate-under-test" }
        "external" { return "candidate-external-engine-opt-in" }
        "external-engine" { return "candidate-external-engine-opt-in" }
        "candidate-external-engine-opt-in" { return "candidate-external-engine-opt-in" }
        default { return $normalized }
    }
}

function Get-ArtifactIndexFileComparisonIds {
    param($FileEntry)

    if ($FileEntry -is [string]) {
        return @()
    }

    $comparisonIds = New-Object System.Collections.Generic.List[string]
    foreach ($name in @("comparison", "comparisonId", "candidate", "candidateId", "mode", "backend")) {
        $comparison = ConvertTo-ComparisonId ([string](Get-JsonValue $FileEntry $name))
        if (-not [string]::IsNullOrWhiteSpace($comparison)) {
            $comparisonIds.Add($comparison) | Out-Null
        }
    }

    foreach ($name in @("comparisons", "comparisonIds", "candidates", "candidateIds")) {
        foreach ($value in (Get-JsonArray $FileEntry $name)) {
            $comparison = ConvertTo-ComparisonId ([string]$value)
            if (-not [string]::IsNullOrWhiteSpace($comparison)) {
                $comparisonIds.Add($comparison) | Out-Null
            }
        }
    }

    $unique = @($comparisonIds.ToArray() | Select-Object -Unique)
    $derived = New-Object System.Collections.Generic.List[string]
    foreach ($comparison in $unique) {
        $derived.Add($comparison) | Out-Null
        if ($comparison -ne "off-baseline" -and $comparison -ne "thetis-parity" -and $comparison -ne "current-zeus") {
            $derived.Add("candidate-under-test") | Out-Null
        }

        if ($comparison -eq "rnnoise" -or $comparison -eq "deepfilternet" -or $comparison -eq "speexdsp" -or $comparison -eq "webrtc-apm") {
            $derived.Add("candidate-external-engine-opt-in") | Out-Null
        }
    }

    return @($derived.ToArray() | Select-Object -Unique)
}

function ConvertTo-MetricId {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    return ($Value.Trim().ToLowerInvariant() -replace "[^a-z0-9]+", "")
}

function Get-MetricIdsFromValue {
    param($Value)

    $metricIds = New-Object System.Collections.Generic.List[string]
    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Array]) {
        foreach ($item in @($Value)) {
            if ($item -is [string]) {
                $metric = ConvertTo-MetricId $item
                if (-not [string]::IsNullOrWhiteSpace($metric)) {
                    $metricIds.Add($metric) | Out-Null
                }
            }
            else {
                foreach ($name in @("id", "name", "metric", "metricId", "key")) {
                    $metric = ConvertTo-MetricId ([string](Get-JsonValue $item $name))
                    if (-not [string]::IsNullOrWhiteSpace($metric)) {
                        $metricIds.Add($metric) | Out-Null
                    }
                }
            }
        }
    }
    elseif ($Value -is [string]) {
        $metric = ConvertTo-MetricId $Value
        if (-not [string]::IsNullOrWhiteSpace($metric)) {
            $metricIds.Add($metric) | Out-Null
        }
    }
    else {
        foreach ($property in @($Value.PSObject.Properties)) {
            $metric = ConvertTo-MetricId $property.Name
            if (-not [string]::IsNullOrWhiteSpace($metric)) {
                $metricIds.Add($metric) | Out-Null
            }
        }
    }

    return @($metricIds.ToArray() | Select-Object -Unique)
}

function Get-MetricResultMetricIds {
    param($Entry)

    $metricIds = New-Object System.Collections.Generic.List[string]
    foreach ($name in @("metrics", "metricResults", "measurements", "values")) {
        foreach ($metric in (Get-MetricIdsFromValue (Get-JsonValue $Entry $name))) {
            $metricIds.Add($metric) | Out-Null
        }
    }

    return @($metricIds.ToArray() | Select-Object -Unique)
}

function Get-GateOutcomeSummary {
    param($Entry)

    $count = 0
    $failed = 0

    foreach ($name in @("gates", "gateResults", "acceptanceGates")) {
        foreach ($gate in (Get-JsonArray $Entry $name)) {
            if ($gate -is [string]) {
                continue
            }

            $passedValue = Get-JsonValue $gate "passed"
            if ($null -eq $passedValue) {
                $passedValue = Get-JsonValue $gate "pass"
            }
            if ($null -eq $passedValue) {
                $passedValue = Get-JsonValue $gate "ok"
            }

            $status = [string](Get-JsonValue $gate "status")
            if ($null -ne $passedValue) {
                $count++
                if (-not (Test-Truthy $passedValue)) {
                    $failed++
                }
            }
            elseif (-not [string]::IsNullOrWhiteSpace($status)) {
                $count++
                $normalizedStatus = $status.Trim().ToLowerInvariant()
                if ($normalizedStatus -ne "pass" -and $normalizedStatus -ne "passed" -and $normalizedStatus -ne "ok") {
                    $failed++
                }
            }
        }
    }

    return [ordered]@{
        count = $count
        failed = $failed
    }
}

function Add-MetricEvidenceEntry {
    param(
        [System.Collections.Generic.List[object]]$Target,
        $Entry,
        [string[]]$InheritedScenarioIds = @(),
        [string[]]$InheritedComparisonIds = @()
    )

    $metricIds = @(Get-MetricResultMetricIds $Entry)
    if ($metricIds.Count -eq 0) {
        return
    }

    $scenarioIds = @(Get-ArtifactIndexFileScenarioIds $Entry)
    if ($scenarioIds.Count -eq 0) {
        $scenarioIds = @($InheritedScenarioIds)
    }

    $comparisonIds = @(Get-ArtifactIndexFileComparisonIds $Entry)
    if ($comparisonIds.Count -eq 0) {
        $comparisonIds = @($InheritedComparisonIds)
    }

    $gateSummary = Get-GateOutcomeSummary $Entry
    $Target.Add([ordered]@{
        scenarioIds = @($scenarioIds)
        comparisonIds = @($comparisonIds)
        metricIds = @($metricIds)
        gateOutcomeCount = [int]$gateSummary.count
        failedGateCount = [int]$gateSummary.failed
    }) | Out-Null
}

function Get-MetricEvidenceEntries {
    param($MetricsJson)

    $entries = New-Object System.Collections.Generic.List[object]
    Add-MetricEvidenceEntry $entries $MetricsJson

    foreach ($name in @("results", "entries", "comparisons", "candidates")) {
        foreach ($entry in (Get-JsonArray $MetricsJson $name)) {
            Add-MetricEvidenceEntry $entries $entry
        }
    }

    foreach ($scenario in (Get-JsonArray $MetricsJson "scenarios")) {
        $scenarioIds = @(Get-ArtifactIndexFileScenarioIds $scenario)
        Add-MetricEvidenceEntry $entries $scenario -InheritedScenarioIds $scenarioIds

        foreach ($name in @("results", "entries", "comparisons", "candidates")) {
            foreach ($entry in (Get-JsonArray $scenario $name)) {
                Add-MetricEvidenceEntry $entries $entry -InheritedScenarioIds $scenarioIds
            }
        }
    }

    return @($entries.ToArray())
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
$artifactFiles = New-Object System.Collections.Generic.List[object]
$artifactReferencedFiles = New-Object System.Collections.Generic.List[object]
$artifactScenarioCoverage = New-Object System.Collections.Generic.List[object]
$artifactComparisonCoverage = New-Object System.Collections.Generic.List[object]
$artifactMetricCoverage = New-Object System.Collections.Generic.List[object]
$parsedFiles = @{}
$artifactManifestReportPath = $null
$artifactManifestProvided = $false
$requiredArtifactFileCount = 0
$requiredArtifactReferencedFileCount = 0
$artifactMissingScenarioCount = 0
$artifactMissingComparisonCount = 0
$artifactMissingMetricCount = 0
$artifactGateOutcomeCount = 0
$artifactFailedGateCount = 0
$captureAllArtifactIds = @{}
$captureRequiredPhysicalArtifactIds = @{}
$captureArtifactScenarioIds = @{}
$scenarioRequiredComparisons = @{}
$scenarioRequiredMetrics = @{}
$metricComparisonArtifactId = "fixture-metric-comparison-report"
$metricComparisonEvidence = [ordered]@{
    present = $false
    readyForReview = $false
    regressionCount = 0
    gateFailureCount = 0
    missingCurrentBaselineCount = 0
    missingThetisBaselineCount = 0
    missingCandidateCount = 0
    missingMetricValueCount = 0
    candidateComparisonCount = 0
    status = "not-evaluated"
}
$liveTraceComparisonArtifactId = "live-diagnostics-trace-comparison"
$liveTraceComparisonEvidence = [ordered]@{
    present = $false
    readyForReview = $false
    regressionCount = 0
    hardConstraintRegressionCount = 0
    gateFailureCount = 0
    missingMetricValueCount = 0
    status = "not-evaluated"
}
$metricCatalogEvidence = [ordered]@{
    present = $false
    metricCount = 0
    requiredMetricCount = 0
    missingRequiredMetricCount = 0
    invalidDirectionCount = 0
    status = "not-evaluated"
}

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
$metricCatalog = $parsedFiles["benchmark-metric-catalog"]
$hardware = $parsedFiles["hardware-diagnostics"]

$hardwareEvidence = [ordered]@{
    planTarget = $null
    manifestTarget = $null
    diagnosticsPresent = $false
    connectionStatus = $null
    connectedBoard = $null
    effectiveBoard = $null
    orionMkIIVariant = $null
    g2Class = $false
    ok = $false
    status = "not-evaluated"
}
$hardwareTargetOk = $true
$hardwareDiagnosticsOk = $false

if ($null -ne $plan) {
    foreach ($scenario in (Get-JsonArray $plan "scenarios")) {
        $scenarioId = [string](Get-JsonValue $scenario "id")
        if (-not [string]::IsNullOrWhiteSpace($scenarioId)) {
            $comparisons = New-Object System.Collections.Generic.List[string]
            foreach ($value in (Get-JsonArray $scenario "requiredComparisons")) {
                $comparison = ConvertTo-ComparisonId ([string]$value)
                if (-not [string]::IsNullOrWhiteSpace($comparison)) {
                    $comparisons.Add($comparison) | Out-Null
                }
            }
            $scenarioRequiredComparisons[$scenarioId] = @($comparisons.ToArray() | Select-Object -Unique)

            $metrics = New-Object System.Collections.Generic.List[string]
            foreach ($value in (Get-JsonArray $scenario "requiredMetrics")) {
                $metric = ConvertTo-MetricId ([string]$value)
                if (-not [string]::IsNullOrWhiteSpace($metric)) {
                    $metrics.Add($metric) | Out-Null
                }
            }
            $scenarioRequiredMetrics[$scenarioId] = @($metrics.ToArray() | Select-Object -Unique)
        }
    }
}

if ($null -eq $metricCatalog) {
    $metricCatalogEvidence["status"] = "missing"
    Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "benchmark-metric-catalog-missing" "benchmark-metric-catalog.json is required so fixture comparison directions are captured with the bundle."
}
else {
    $metricCatalogEvidence["present"] = $true
    $catalogMetricIds = @{}
    $invalidDirectionCount = 0

    foreach ($metric in (Get-JsonArray $metricCatalog "metrics")) {
        $metricId = ConvertTo-MetricId ([string](Get-JsonValue $metric "id"))
        if ([string]::IsNullOrWhiteSpace($metricId)) {
            $metricId = ConvertTo-MetricId ([string](Get-JsonValue $metric "name"))
        }

        if ([string]::IsNullOrWhiteSpace($metricId)) {
            continue
        }

        $catalogMetricIds[$metricId] = $true
        $direction = [string](Get-JsonValue $metric "direction")
        if ($direction -ne "higher" -and $direction -ne "lower" -and $direction -ne "informational") {
            $invalidDirectionCount++
            Add-ValidationIssue $errors "error" "benchmark-metric-direction-invalid" "Benchmark metric catalog entry '$metricId' has invalid direction '$direction'."
        }
    }

    $requiredMetricIds = @{}
    foreach ($scenarioId in $scenarioRequiredMetrics.Keys) {
        foreach ($metricId in @($scenarioRequiredMetrics[$scenarioId])) {
            $metric = ConvertTo-MetricId ([string]$metricId)
            if (-not [string]::IsNullOrWhiteSpace($metric)) {
                $requiredMetricIds[$metric] = $true
            }
        }
    }

    $missingCatalogMetricIds = New-Object System.Collections.Generic.List[string]
    foreach ($metricId in ($requiredMetricIds.Keys | Sort-Object)) {
        if (-not $catalogMetricIds.ContainsKey($metricId)) {
            $missingCatalogMetricIds.Add($metricId) | Out-Null
        }
    }

    if ($missingCatalogMetricIds.Count -gt 0) {
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "benchmark-metric-catalog-incomplete" "Benchmark metric catalog is missing required metrics: $($missingCatalogMetricIds.ToArray() -join ', ')."
    }

    $metricCatalogEvidence["metricCount"] = $catalogMetricIds.Count
    $metricCatalogEvidence["requiredMetricCount"] = $requiredMetricIds.Count
    $metricCatalogEvidence["missingRequiredMetricCount"] = $missingCatalogMetricIds.Count
    $metricCatalogEvidence["invalidDirectionCount"] = $invalidDirectionCount
    $metricCatalogEvidence["status"] = if ($missingCatalogMetricIds.Count -eq 0 -and $invalidDirectionCount -eq 0) { "ready" } else { "not-ready" }
}

$planHardwareTarget = ""
if ($null -ne $plan) {
    $planHardwareTarget = [string](Get-JsonValue $plan "firstHardwareTarget")
    $hardwareEvidence["planTarget"] = $planHardwareTarget

    if ([string]::IsNullOrWhiteSpace($planHardwareTarget)) {
        $hardwareTargetOk = $false
        Add-ValidationIssue $errors "error" "benchmark-first-hardware-target-missing" "Benchmark plan must declare firstHardwareTarget for first-cycle DSP evidence."
    }
    elseif (-not (Test-G2BenchmarkTarget $planHardwareTarget)) {
        $hardwareTargetOk = $false
        Add-ValidationIssue $errors "error" "benchmark-first-hardware-target-not-g2" "Benchmark plan firstHardwareTarget must remain G2 for first-cycle DSP evidence; found '$planHardwareTarget'."
    }

    $requiredHardwareText = (Get-JsonArray $plan "requiredHardwareBeforeGraduation") -join " "
    if ($requiredHardwareText -notlike "*G2*" -or $requiredHardwareText -notlike "*non-G2*") {
        Add-ValidationIssue $errors "error" "benchmark-hardware-graduation-gates-incomplete" "Benchmark plan must keep both G2 first-pass validation and non-G2 cross-radio validation before graduation."
    }
}

if ($null -ne $manifest) {
    $manifestHardwareTarget = [string](Get-JsonValue $manifest "hardwareTarget")
    $hardwareEvidence["manifestTarget"] = $manifestHardwareTarget

    if ([string]::IsNullOrWhiteSpace($manifestHardwareTarget)) {
        $hardwareTargetOk = $false
        Add-ValidationIssue $errors "error" "capture-hardware-target-missing" "Capture manifest must declare hardwareTarget."
    }
    elseif (-not (Test-G2BenchmarkTarget $manifestHardwareTarget)) {
        $hardwareTargetOk = $false
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "capture-hardware-target-not-g2" "Capture manifest hardwareTarget must be G2 for first-cycle DSP evidence; found '$manifestHardwareTarget'."
    }

    $planTargetId = ConvertTo-HardwareId $planHardwareTarget
    $manifestTargetId = ConvertTo-HardwareId $manifestHardwareTarget
    if ((-not [string]::IsNullOrWhiteSpace($planTargetId)) -and
        (-not [string]::IsNullOrWhiteSpace($manifestTargetId)) -and
        ($planTargetId -ne $manifestTargetId)) {
        $hardwareTargetOk = $false
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "capture-hardware-target-mismatch" "Capture manifest hardwareTarget '$manifestHardwareTarget' does not match benchmark plan firstHardwareTarget '$planHardwareTarget'."
    }
}

if ($null -eq $hardware) {
    $hardwareEvidence["status"] = "diagnostics-missing"
    Add-ValidationIssue $errors "error" "hardware-diagnostics-missing" "hardware-diagnostics.json is required for G2 first-cycle DSP evidence."
}
else {
    $hardwareEvidence["diagnosticsPresent"] = $true

    $connectionStatus = [string](Get-JsonValue $hardware "connectionStatus")
    $connectedBoard = [string](Get-HardwareDiagnosticField $hardware "connectedBoard")
    $effectiveBoard = [string](Get-HardwareDiagnosticField $hardware "effectiveBoard")
    $variant = [string](Get-HardwareDiagnosticField $hardware "orionMkIIVariant")
    $g2Class = Test-Truthy (Get-HardwareDiagnosticField $hardware "g2Class")

    $hardwareEvidence["connectionStatus"] = $connectionStatus
    $hardwareEvidence["connectedBoard"] = $connectedBoard
    $hardwareEvidence["effectiveBoard"] = $effectiveBoard
    $hardwareEvidence["orionMkIIVariant"] = $variant
    $hardwareEvidence["g2Class"] = $g2Class

    $connectedOk = $connectionStatus -ieq "Connected"
    if (-not $connectedOk) {
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "hardware-diagnostics-not-connected" "Hardware diagnostics must be captured from a connected G2 radio; connectionStatus is '$connectionStatus'."
    }

    $orionEvidence = (Test-OrionMkIIBoard $connectedBoard) -or (Test-OrionMkIIBoard $effectiveBoard)
    $variantEvidence = Test-G2Variant $variant
    $g2Evidence = $g2Class -and $orionEvidence -and $variantEvidence

    if (-not $g2Evidence) {
        Add-AcceptanceIssue $errors $warnings -AllowPreflight:$AllowPreflight "hardware-diagnostics-not-g2" "Hardware diagnostics must show G2-class OrionMkII evidence; connectedBoard='$connectedBoard', effectiveBoard='$effectiveBoard', orionMkIIVariant='$variant', g2Class='$g2Class'."
    }

    $hardwareDiagnosticsOk = $connectedOk -and $g2Evidence
    if ($hardwareDiagnosticsOk) {
        $hardwareEvidence["status"] = "g2-hardware-evidence-ready"
    }
    elseif (-not $connectedOk) {
        $hardwareEvidence["status"] = "not-connected"
    }
    else {
        $hardwareEvidence["status"] = "not-g2"
    }
}

$hardwareEvidence["ok"] = ($hardwareTargetOk -and $hardwareDiagnosticsOk)

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
            $captureAllArtifactIds[$artifactId] = $true

            $artifactKind = [string](Get-JsonValue $artifact "kind")
            $artifactRequired = Test-Truthy (Get-JsonValue $artifact "required")
            if ($artifactRequired -and $artifactKind -ine "endpoint-json") {
                $captureRequiredPhysicalArtifactIds[$artifactId] = $true
            }
            $captureArtifactScenarioIds[$artifactId] = @(Get-JsonArray $artifact "scenarioIds")
        }
    }

    $captureAllArtifactIds[$metricComparisonArtifactId] = $true
    $captureRequiredPhysicalArtifactIds[$metricComparisonArtifactId] = $true
    $captureArtifactScenarioIds[$metricComparisonArtifactId] = @(Get-JsonArray $manifest "scenarioIds")

    foreach ($requiredArtifact in @("live-diagnostics-json", "benchmark-plan-json", "offline-fixture-metrics")) {
        if (-not $artifactIds.ContainsKey($requiredArtifact)) {
            Add-ValidationIssue $errors "error" "manifest-required-artifact-missing" "Capture manifest is missing required artifact '$requiredArtifact'."
        }
    }
}

$artifactManifestCandidate = ""
$artifactManifestSpecified = -not [string]::IsNullOrWhiteSpace($ArtifactManifestPath)
if ($artifactManifestSpecified) {
    $artifactManifestCandidate = Get-BundlePath $bundlePath $ArtifactManifestPath
}
else {
    $defaultArtifactManifestPath = Join-Path $bundlePath "artifact-manifest.json"
    if (Test-Path -LiteralPath $defaultArtifactManifestPath -PathType Leaf) {
        $artifactManifestCandidate = $defaultArtifactManifestPath
    }
}

if ([string]::IsNullOrWhiteSpace($artifactManifestCandidate)) {
    if ($RequireArtifactFiles) {
        Add-ValidationIssue $errors "error" "artifact-manifest-missing" "Artifact file validation was required, but no artifact-manifest.json was found in the bundle."
    }
    else {
        Add-ValidationIssue $warnings "warning" "artifact-manifest-not-provided" "No artifact-manifest.json was provided; endpoint JSON was checked, but offline metrics/audio/spectrum files were not validated."
    }
}
elseif (-not (Test-Path -LiteralPath $artifactManifestCandidate -PathType Leaf)) {
    Add-ValidationIssue $errors "error" "artifact-manifest-missing" "Artifact manifest file is missing: $artifactManifestCandidate"
}
else {
    $artifactManifestReportPath = (Resolve-Path -LiteralPath $artifactManifestCandidate).Path
    $artifactManifestProvided = $true
    $artifactManifest = $null

    try {
        $artifactManifest = Read-JsonFile $artifactManifestReportPath
    }
    catch {
        Add-ValidationIssue $errors "error" "artifact-manifest-invalid" $_.Exception.Message
    }

    if ($null -ne $artifactManifest) {
        $schemaVersion = Get-JsonValue $artifactManifest "schemaVersion"
        if ($null -ne $schemaVersion) {
            $parsedSchemaVersion = 0
            if (-not [int]::TryParse([string]$schemaVersion, [ref]$parsedSchemaVersion) -or $parsedSchemaVersion -ne 1) {
                Add-ValidationIssue $errors "error" "artifact-manifest-schema-unsupported" "Artifact manifest schemaVersion must be 1."
            }
        }

        $declaredArtifacts = Get-JsonArray $artifactManifest "artifacts"
        if ($declaredArtifacts.Count -eq 0) {
            Add-ValidationIssue $errors "error" "artifact-manifest-artifacts-missing" "Artifact manifest does not list any artifacts."
        }

        $declaredArtifactIds = @{}
        foreach ($artifact in $declaredArtifacts) {
            $artifactId = [string](Get-JsonValue $artifact "id")
            $artifactKind = [string](Get-JsonValue $artifact "kind")
            $artifactPath = [string](Get-JsonValue $artifact "path")
            $manifestRequired = Test-Truthy (Get-JsonValue $artifact "required")
            $effectiveRequired = $manifestRequired
            $expectedScenarioIds = @(Get-JsonArray $artifact "scenarioIds")

            if (-not [string]::IsNullOrWhiteSpace($artifactId) -and $captureRequiredPhysicalArtifactIds.ContainsKey($artifactId)) {
                $effectiveRequired = $true
            }
            if ($expectedScenarioIds.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($artifactId) -and $captureArtifactScenarioIds.ContainsKey($artifactId)) {
                $expectedScenarioIds = @($captureArtifactScenarioIds[$artifactId])
            }

            if ($effectiveRequired) {
                $requiredArtifactFileCount++
            }

            $record = [ordered]@{
                id = $artifactId
                kind = $artifactKind
                path = $artifactPath
                required = $effectiveRequired
                scenarioIds = @($expectedScenarioIds)
                ok = $false
                bytes = 0
                jsonlLineCount = 0
            }
            $artifactFiles.Add($record) | Out-Null

            if ([string]::IsNullOrWhiteSpace($artifactId)) {
                Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-id-missing" "Artifact manifest contains an entry with no id."
                continue
            }

            $declaredArtifactIds[$artifactId] = $true

            if (-not $captureAllArtifactIds.ContainsKey($artifactId) -and $artifactKind -ine "notes") {
                Add-ValidationIssue $warnings "warning" "artifact-not-in-capture-manifest" "Artifact '$artifactId' is not referenced by the capture manifest requiredArtifacts list."
            }

            if ([string]::IsNullOrWhiteSpace($artifactPath)) {
                Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-path-missing" "Artifact '$artifactId' does not declare a path."
                continue
            }

            if ([System.IO.Path]::IsPathRooted($artifactPath)) {
                Add-ValidationIssue $warnings "warning" "artifact-path-absolute" "Artifact '$artifactId' uses an absolute path; relative paths keep capture bundles portable."
            }

            $resolvedArtifactPath = Get-BundlePath $bundlePath $artifactPath
            if (-not (Test-Path -LiteralPath $resolvedArtifactPath -PathType Leaf)) {
                Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-file-missing" "Artifact '$artifactId' file is missing: $artifactPath"
                continue
            }

            $item = Get-Item -LiteralPath $resolvedArtifactPath
            $record["bytes"] = $item.Length
            if ($item.Length -le 0) {
                Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-file-empty" "Artifact '$artifactId' file is empty: $artifactPath"
                continue
            }

            $artifactJson = $null
            if (Test-JsonlArtifact $artifactKind $artifactPath) {
                try {
                    $record["jsonlLineCount"] = Test-JsonlFile $resolvedArtifactPath
                    if ([int]$record["jsonlLineCount"] -le 0) {
                        Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-jsonl-empty" "Artifact '$artifactId' JSONL file has no records: $artifactPath"
                        continue
                    }
                }
                catch {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-jsonl-invalid" $_.Exception.Message
                    continue
                }
            }
            elseif (Test-JsonArtifact $artifactKind $artifactPath) {
                try {
                    $artifactJson = Read-JsonFile $resolvedArtifactPath
                }
                catch {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-json-invalid" $_.Exception.Message
                    continue
                }
            }

            $artifactValidationOk = $true
            if ($artifactKind -ieq "metrics-json" -or $artifactId -eq "offline-fixture-metrics") {
                $metricEntries = @(Get-MetricEvidenceEntries $artifactJson)
                if ($metricEntries.Count -eq 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-metrics-missing" "Artifact '$artifactId' does not contain any metric result entries."
                    $artifactValidationOk = $false
                }

                $metricCoverageByScenarioComparison = @{}
                foreach ($metricEntry in $metricEntries) {
                    foreach ($scenarioId in @($metricEntry.scenarioIds)) {
                        $scenario = [string]$scenarioId
                        if ([string]::IsNullOrWhiteSpace($scenario)) {
                            continue
                        }

                        foreach ($comparisonId in @($metricEntry.comparisonIds)) {
                            $comparison = ConvertTo-ComparisonId ([string]$comparisonId)
                            if ([string]::IsNullOrWhiteSpace($comparison)) {
                                continue
                            }

                            $key = "$scenario||$comparison"
                            if (-not $metricCoverageByScenarioComparison.ContainsKey($key)) {
                                $metricCoverageByScenarioComparison[$key] = [ordered]@{
                                    metricIds = @{}
                                    gateOutcomeCount = 0
                                    failedGateCount = 0
                                }
                            }

                            foreach ($metricId in @($metricEntry.metricIds)) {
                                $metric = ConvertTo-MetricId ([string]$metricId)
                                if (-not [string]::IsNullOrWhiteSpace($metric)) {
                                    $metricCoverageByScenarioComparison[$key].metricIds[$metric] = $true
                                }
                            }

                            $metricCoverageByScenarioComparison[$key].gateOutcomeCount += [int]$metricEntry.gateOutcomeCount
                            $metricCoverageByScenarioComparison[$key].failedGateCount += [int]$metricEntry.failedGateCount
                        }
                    }
                }

                foreach ($expectedScenarioId in $expectedScenarioIds) {
                    $scenario = [string]$expectedScenarioId
                    if ([string]::IsNullOrWhiteSpace($scenario)) {
                        continue
                    }

                    $requiredComparisons = @()
                    if ($scenarioRequiredComparisons.ContainsKey($scenario)) {
                        $requiredComparisons = @($scenarioRequiredComparisons[$scenario])
                    }

                    $requiredMetrics = @()
                    if ($scenarioRequiredMetrics.ContainsKey($scenario)) {
                        $requiredMetrics = @($scenarioRequiredMetrics[$scenario])
                    }

                    if ($requiredComparisons.Count -eq 0 -or $requiredMetrics.Count -eq 0) {
                        continue
                    }

                    foreach ($requiredComparison in $requiredComparisons) {
                        $comparison = ConvertTo-ComparisonId ([string]$requiredComparison)
                        if ([string]::IsNullOrWhiteSpace($comparison)) {
                            continue
                        }

                        $key = "$scenario||$comparison"
                        $coveredMetricIds = @{}
                        $gateOutcomeCount = 0
                        $failedGateCount = 0
                        if ($metricCoverageByScenarioComparison.ContainsKey($key)) {
                            $coveredMetricIds = $metricCoverageByScenarioComparison[$key].metricIds
                            $gateOutcomeCount = [int]$metricCoverageByScenarioComparison[$key].gateOutcomeCount
                            $failedGateCount = [int]$metricCoverageByScenarioComparison[$key].failedGateCount
                        }

                        $missingMetricIds = New-Object System.Collections.Generic.List[string]
                        foreach ($requiredMetric in $requiredMetrics) {
                            $metric = ConvertTo-MetricId ([string]$requiredMetric)
                            if (-not [string]::IsNullOrWhiteSpace($metric) -and -not $coveredMetricIds.ContainsKey($metric)) {
                                $missingMetricIds.Add($metric) | Out-Null
                            }
                        }

                        $artifactGateOutcomeCount += $gateOutcomeCount
                        $artifactFailedGateCount += $failedGateCount

                        $metricCoverageRecord = [ordered]@{
                            artifactId = $artifactId
                            scenarioId = $scenario
                            comparisonId = $comparison
                            required = $effectiveRequired
                            ok = ($missingMetricIds.Count -eq 0 -and $gateOutcomeCount -gt 0 -and $failedGateCount -eq 0)
                            requiredMetricIds = @($requiredMetrics)
                            coveredMetricIds = @($coveredMetricIds.Keys | Sort-Object)
                            missingMetricIds = @($missingMetricIds.ToArray())
                            gateOutcomeCount = $gateOutcomeCount
                            failedGateCount = $failedGateCount
                        }
                        $artifactMetricCoverage.Add($metricCoverageRecord) | Out-Null

                        if ($missingMetricIds.Count -gt 0) {
                            $artifactMissingMetricCount += $missingMetricIds.Count
                            Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-metric-missing" "Artifact '$artifactId' metrics are missing required metrics for scenario '$scenario' comparison '$comparison': $($missingMetricIds.ToArray() -join ', ')."
                            $artifactValidationOk = $false
                        }

                        if ($gateOutcomeCount -le 0) {
                            Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-gate-outcome-missing" "Artifact '$artifactId' metrics are missing gate outcomes for scenario '$scenario' comparison '$comparison'."
                            $artifactValidationOk = $false
                        }

                        if ($failedGateCount -gt 0) {
                            Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-gate-failed" "Artifact '$artifactId' metrics report $failedGateCount failed gate outcome(s) for scenario '$scenario' comparison '$comparison'."
                            $artifactValidationOk = $false
                        }
                    }
                }
            }

            if ($artifactKind -ieq "comparison-json" -or $artifactId -eq $metricComparisonArtifactId) {
                $metricComparisonEvidence["present"] = $true

                $tool = [string](Get-JsonValue $artifactJson "tool")
                if ($tool -ne "compare-dsp-fixture-metrics") {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-tool-invalid" "Artifact '$artifactId' must be generated by compare-dsp-fixture-metrics.ps1."
                    $artifactValidationOk = $false
                }

                $readyForReview = Test-Truthy (Get-JsonValue $artifactJson "readyForReview")
                $regressions = [int](Get-JsonValue $artifactJson "regressionCount")
                $gateFailures = [int](Get-JsonValue $artifactJson "gateFailureCount")
                $missingCurrent = [int](Get-JsonValue $artifactJson "missingCurrentBaselineCount")
                $missingThetis = [int](Get-JsonValue $artifactJson "missingThetisBaselineCount")
                $missingCandidate = [int](Get-JsonValue $artifactJson "missingCandidateCount")
                $missingMetrics = [int](Get-JsonValue $artifactJson "missingMetricValueCount")
                $candidateComparisons = [int](Get-JsonValue $artifactJson "candidateComparisonCount")

                $metricComparisonEvidence["readyForReview"] = $readyForReview
                $metricComparisonEvidence["regressionCount"] = $regressions
                $metricComparisonEvidence["gateFailureCount"] = $gateFailures
                $metricComparisonEvidence["missingCurrentBaselineCount"] = $missingCurrent
                $metricComparisonEvidence["missingThetisBaselineCount"] = $missingThetis
                $metricComparisonEvidence["missingCandidateCount"] = $missingCandidate
                $metricComparisonEvidence["missingMetricValueCount"] = $missingMetrics
                $metricComparisonEvidence["candidateComparisonCount"] = $candidateComparisons

                if (-not $readyForReview) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-not-ready" "Artifact '$artifactId' reports readyForReview=false."
                    $artifactValidationOk = $false
                }
                if ($candidateComparisons -le 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-candidate-missing" "Artifact '$artifactId' does not compare any candidate metrics."
                    $artifactValidationOk = $false
                }
                if ($regressions -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-regression" "Artifact '$artifactId' reports $regressions metric regression(s)."
                    $artifactValidationOk = $false
                }
                if ($gateFailures -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-gate-failed" "Artifact '$artifactId' reports $gateFailures failed gate outcome(s)."
                    $artifactValidationOk = $false
                }
                if ($missingCurrent -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-current-baseline-missing" "Artifact '$artifactId' is missing current-Zeus baseline coverage for $missingCurrent candidate scenario(s)."
                    $artifactValidationOk = $false
                }
                if ($missingThetis -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-thetis-baseline-missing" "Artifact '$artifactId' is missing Thetis-parity baseline coverage for $missingThetis candidate scenario(s)."
                    $artifactValidationOk = $false
                }
                if ($missingCandidate -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-candidate-coverage-missing" "Artifact '$artifactId' is missing candidate coverage for $missingCandidate benchmark scenario(s)."
                    $artifactValidationOk = $false
                }
                if ($missingMetrics -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "metric-comparison-value-missing" "Artifact '$artifactId' is missing $missingMetrics baseline/candidate metric value(s)."
                    $artifactValidationOk = $false
                }

                if ($artifactValidationOk) {
                    $metricComparisonEvidence["status"] = "ready"
                }
                else {
                    $metricComparisonEvidence["status"] = "not-ready"
                }
            }

            if ($artifactKind -ieq "diagnostics-comparison-json" -or $artifactId -eq $liveTraceComparisonArtifactId) {
                $liveTraceComparisonEvidence["present"] = $true

                $tool = [string](Get-JsonValue $artifactJson "tool")
                if ($tool -ne "compare-dsp-live-diagnostics-traces") {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "live-trace-comparison-tool-invalid" "Artifact '$artifactId' must be generated by compare-dsp-live-diagnostics-traces.ps1."
                    $artifactValidationOk = $false
                }

                $readyForReview = Test-Truthy (Get-JsonValue $artifactJson "readyForReview")
                $regressions = [int](Get-JsonValue $artifactJson "regressionCount")
                $hardConstraintRegressions = [int](Get-JsonValue $artifactJson "hardConstraintRegressionCount")
                $gateFailures = [int](Get-JsonValue $artifactJson "gateFailureCount")
                $missingMetrics = [int](Get-JsonValue $artifactJson "missingMetricValueCount")

                $liveTraceComparisonEvidence["readyForReview"] = $readyForReview
                $liveTraceComparisonEvidence["regressionCount"] = $regressions
                $liveTraceComparisonEvidence["hardConstraintRegressionCount"] = $hardConstraintRegressions
                $liveTraceComparisonEvidence["gateFailureCount"] = $gateFailures
                $liveTraceComparisonEvidence["missingMetricValueCount"] = $missingMetrics

                if (-not $readyForReview) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "live-trace-comparison-not-ready" "Artifact '$artifactId' reports readyForReview=false."
                    $artifactValidationOk = $false
                }
                if ($regressions -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "live-trace-comparison-regression" "Artifact '$artifactId' reports $regressions live diagnostics metric regression(s)."
                    $artifactValidationOk = $false
                }
                if ($hardConstraintRegressions -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "live-trace-comparison-hard-constraint-regression" "Artifact '$artifactId' reports $hardConstraintRegressions hard live diagnostics constraint regression(s)."
                    $artifactValidationOk = $false
                }
                if ($gateFailures -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "live-trace-comparison-gate-failed" "Artifact '$artifactId' reports $gateFailures live diagnostics gate failure(s)."
                    $artifactValidationOk = $false
                }
                if ($missingMetrics -gt 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "live-trace-comparison-value-missing" "Artifact '$artifactId' is missing $missingMetrics baseline/candidate metric value(s)."
                    $artifactValidationOk = $false
                }

                if ($artifactValidationOk) {
                    $liveTraceComparisonEvidence["status"] = "ready"
                }
                else {
                    $liveTraceComparisonEvidence["status"] = "not-ready"
                }
            }

            if (Test-ArtifactIndex $artifactKind $artifactPath) {
                $indexedFiles = Get-JsonArray $artifactJson "files"
                if ($indexedFiles.Count -eq 0) {
                    Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-index-files-missing" "Artifact '$artifactId' index does not list any files."
                    $artifactValidationOk = $false
                    continue
                }

                $coveredScenarioIds = @{}
                $coveredComparisonsByScenario = @{}
                foreach ($indexedFile in $indexedFiles) {
                    $indexedPath = Get-ArtifactIndexFilePath $indexedFile
                    $indexedScenarioIds = @(Get-ArtifactIndexFileScenarioIds $indexedFile)
                    $indexedComparisonIds = @(Get-ArtifactIndexFileComparisonIds $indexedFile)
                    $indexedRecord = [ordered]@{
                        artifactId = $artifactId
                        artifactKind = $artifactKind
                        path = $indexedPath
                        scenarioIds = @($indexedScenarioIds)
                        comparisonIds = @($indexedComparisonIds)
                        required = $effectiveRequired
                        ok = $false
                        bytes = 0
                    }
                    $artifactReferencedFiles.Add($indexedRecord) | Out-Null

                    if ($effectiveRequired) {
                        $requiredArtifactReferencedFileCount++
                    }

                    foreach ($indexedScenarioId in $indexedScenarioIds) {
                        $coveredScenarioIds[$indexedScenarioId] = $true
                        if (-not $coveredComparisonsByScenario.ContainsKey($indexedScenarioId)) {
                            $coveredComparisonsByScenario[$indexedScenarioId] = @{}
                        }

                        foreach ($indexedComparisonId in $indexedComparisonIds) {
                            $coveredComparisonsByScenario[$indexedScenarioId][$indexedComparisonId] = $true
                        }
                    }

                    if ([string]::IsNullOrWhiteSpace($indexedPath)) {
                        Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-index-file-path-missing" "Artifact '$artifactId' index contains a file entry with no path."
                        $artifactValidationOk = $false
                        continue
                    }

                    if ([System.IO.Path]::IsPathRooted($indexedPath)) {
                        Add-ValidationIssue $warnings "warning" "artifact-index-file-path-absolute" "Artifact '$artifactId' index uses an absolute file path; relative paths keep capture bundles portable."
                    }

                    $resolvedIndexedPath = Get-BundlePath $bundlePath $indexedPath
                    if (-not (Test-Path -LiteralPath $resolvedIndexedPath -PathType Leaf)) {
                        Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-index-file-missing" "Artifact '$artifactId' index references a missing file: $indexedPath"
                        $artifactValidationOk = $false
                        continue
                    }

                    $indexedItem = Get-Item -LiteralPath $resolvedIndexedPath
                    $indexedRecord["bytes"] = $indexedItem.Length
                    if ($indexedItem.Length -le 0) {
                        Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-index-file-empty" "Artifact '$artifactId' index references an empty file: $indexedPath"
                        $artifactValidationOk = $false
                        continue
                    }

                    $indexedRecord["ok"] = $true
                }

                if ($expectedScenarioIds.Count -gt 0) {
                    $missingScenarioIds = New-Object System.Collections.Generic.List[string]
                    foreach ($expectedScenarioId in $expectedScenarioIds) {
                        $scenario = [string]$expectedScenarioId
                        if (-not [string]::IsNullOrWhiteSpace($scenario) -and -not $coveredScenarioIds.ContainsKey($scenario)) {
                            $missingScenarioIds.Add($scenario) | Out-Null
                        }
                    }

                    $coverageRecord = [ordered]@{
                        artifactId = $artifactId
                        artifactKind = $artifactKind
                        required = $effectiveRequired
                        ok = ($missingScenarioIds.Count -eq 0)
                        requiredScenarioIds = @($expectedScenarioIds)
                        coveredScenarioIds = @($coveredScenarioIds.Keys | Sort-Object)
                        missingScenarioIds = @($missingScenarioIds.ToArray())
                    }
                    $artifactScenarioCoverage.Add($coverageRecord) | Out-Null

                    if ($missingScenarioIds.Count -gt 0) {
                        $artifactMissingScenarioCount += $missingScenarioIds.Count
                        Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-index-scenario-missing" "Artifact '$artifactId' index is missing scenario coverage: $($missingScenarioIds.ToArray() -join ', ')."
                        $artifactValidationOk = $false
                    }

                    foreach ($expectedScenarioId in $expectedScenarioIds) {
                        $scenario = [string]$expectedScenarioId
                        if ([string]::IsNullOrWhiteSpace($scenario)) {
                            continue
                        }

                        $requiredComparisons = @()
                        if ($scenarioRequiredComparisons.ContainsKey($scenario)) {
                            $requiredComparisons = @($scenarioRequiredComparisons[$scenario])
                        }

                        if ($requiredComparisons.Count -eq 0) {
                            continue
                        }

                        $coveredComparisons = @{}
                        if ($coveredComparisonsByScenario.ContainsKey($scenario)) {
                            $coveredComparisons = $coveredComparisonsByScenario[$scenario]
                        }

                        $missingComparisons = New-Object System.Collections.Generic.List[string]
                        foreach ($requiredComparison in $requiredComparisons) {
                            $comparison = ConvertTo-ComparisonId ([string]$requiredComparison)
                            if (-not [string]::IsNullOrWhiteSpace($comparison) -and -not $coveredComparisons.ContainsKey($comparison)) {
                                $missingComparisons.Add($comparison) | Out-Null
                            }
                        }

                        $comparisonCoverageRecord = [ordered]@{
                            artifactId = $artifactId
                            artifactKind = $artifactKind
                            scenarioId = $scenario
                            required = $effectiveRequired
                            ok = ($missingComparisons.Count -eq 0)
                            requiredComparisonIds = @($requiredComparisons)
                            coveredComparisonIds = @($coveredComparisons.Keys | Sort-Object)
                            missingComparisonIds = @($missingComparisons.ToArray())
                        }
                        $artifactComparisonCoverage.Add($comparisonCoverageRecord) | Out-Null

                        if ($missingComparisons.Count -gt 0) {
                            $artifactMissingComparisonCount += $missingComparisons.Count
                            Add-ArtifactIssue $errors $warnings -Required:$effectiveRequired "artifact-index-comparison-missing" "Artifact '$artifactId' index is missing comparison coverage for scenario '$scenario': $($missingComparisons.ToArray() -join ', ')."
                            $artifactValidationOk = $false
                        }
                    }
                }
            }

            $record["ok"] = $artifactValidationOk
        }

        foreach ($requiredPhysicalArtifact in ($captureRequiredPhysicalArtifactIds.Keys | Sort-Object)) {
            if (-not $declaredArtifactIds.ContainsKey($requiredPhysicalArtifact)) {
                $message = "Artifact manifest is missing required physical artifact '$requiredPhysicalArtifact' from the capture manifest."
                Add-ArtifactIssue $errors $warnings -Required:$RequireArtifactFiles "artifact-file-entry-missing" $message
            }
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
    requireArtifactFiles = [bool]$RequireArtifactFiles
    artifactManifestProvided = $artifactManifestProvided
    artifactManifestPath = $artifactManifestReportPath
    artifactFileCount = $artifactFiles.Count
    requiredArtifactFileCount = $requiredArtifactFileCount
    artifactReferencedFileCount = $artifactReferencedFiles.Count
    requiredArtifactReferencedFileCount = $requiredArtifactReferencedFileCount
    artifactScenarioCoverageCount = $artifactScenarioCoverage.Count
    artifactMissingScenarioCount = $artifactMissingScenarioCount
    artifactComparisonCoverageCount = $artifactComparisonCoverage.Count
    artifactMissingComparisonCount = $artifactMissingComparisonCount
    artifactMetricCoverageCount = $artifactMetricCoverage.Count
    artifactMissingMetricCount = $artifactMissingMetricCount
    artifactGateOutcomeCount = $artifactGateOutcomeCount
    artifactFailedGateCount = $artifactFailedGateCount
    hardwareTarget = $hardwareEvidence.planTarget
    captureHardwareTarget = $hardwareEvidence.manifestTarget
    hardwareDiagnosticsPresent = $hardwareEvidence.diagnosticsPresent
    hardwareEvidenceStatus = $hardwareEvidence.status
    metricComparisonPresent = $metricComparisonEvidence.present
    metricComparisonReady = $metricComparisonEvidence.readyForReview
    metricComparisonRegressionCount = $metricComparisonEvidence.regressionCount
    metricComparisonGateFailureCount = $metricComparisonEvidence.gateFailureCount
    liveTraceComparisonPresent = $liveTraceComparisonEvidence.present
    liveTraceComparisonReady = $liveTraceComparisonEvidence.readyForReview
    liveTraceComparisonRegressionCount = $liveTraceComparisonEvidence.regressionCount
    liveTraceComparisonHardConstraintRegressionCount = $liveTraceComparisonEvidence.hardConstraintRegressionCount
    liveTraceComparisonGateFailureCount = $liveTraceComparisonEvidence.gateFailureCount
    metricCatalogPresent = $metricCatalogEvidence.present
    metricCatalogStatus = $metricCatalogEvidence.status
    metricCatalogMetricCount = $metricCatalogEvidence.metricCount
    metricCatalogMissingRequiredMetricCount = $metricCatalogEvidence.missingRequiredMetricCount
    errorCount = $errors.Count
    warningCount = $warnings.Count
    hardwareEvidence = $hardwareEvidence
    metricCatalogEvidence = $metricCatalogEvidence
    metricComparisonEvidence = $metricComparisonEvidence
    liveTraceComparisonEvidence = $liveTraceComparisonEvidence
    artifactFiles = @($artifactFiles.ToArray())
    artifactReferencedFiles = @($artifactReferencedFiles.ToArray())
    artifactScenarioCoverage = @($artifactScenarioCoverage.ToArray())
    artifactComparisonCoverage = @($artifactComparisonCoverage.ToArray())
    artifactMetricCoverage = @($artifactMetricCoverage.ToArray())
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
