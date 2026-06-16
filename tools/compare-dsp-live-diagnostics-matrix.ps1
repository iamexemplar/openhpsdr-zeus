param(
    [Parameter(Mandatory = $true)]
    [string]$BaselineIndexPath,

    [Parameter(Mandatory = $true)]
    [string]$CandidateIndexPath,

    [string]$BaselineRoot = "",

    [string]$CandidateRoot = "",

    [string]$BundleDir = "",

    [string]$BaselineComparisonId = "",

    [string]$CandidateComparisonId = "",

    [string]$BaselineLabel = "current-zeus",

    [string]$CandidateLabel = "candidate-under-test",

    [string]$ReportPath = "",

    [string]$MarkdownPath = "",

    [string]$OutputDir = "",

    [double]$Tolerance = 0.000001,

    [switch]$FailOnRegression,

    [switch]$NoMarkdown,

    [switch]$JsonOnly
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        throw "Failed to parse JSON file '$Path': $($_.Exception.Message)"
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    $json = $Value | ConvertTo-Json -Depth 64
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
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
    if ($null -ne $property) {
        return $property.Value
    }

    foreach ($candidate in @($Object.PSObject.Properties)) {
        if ([string]::Equals($candidate.Name, $Name, [StringComparison]::OrdinalIgnoreCase)) {
            return $candidate.Value
        }
    }

    return $null
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

function ConvertTo-SafeName {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return "trace"
    }

    $safe = $Value.Trim().ToLowerInvariant() -replace "[^a-z0-9._-]+", "-"
    $safe = $safe.Trim("-")
    if ($safe.Length -gt 96) {
        $safe = $safe.Substring(0, 96).Trim("-")
    }
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return "trace"
    }

    return $safe
}

function ConvertTo-ComparisonId {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    return ($Value.Trim().ToLowerInvariant() -replace "[^a-z0-9]+", "-").Trim("-")
}

function Resolve-IndexRoot {
    param(
        [Parameter(Mandatory = $true)][string]$IndexPath,
        [string]$RootOverride
    )

    if (-not [string]::IsNullOrWhiteSpace($RootOverride)) {
        return (Resolve-Path -LiteralPath $RootOverride).Path
    }

    $indexDir = Split-Path -Parent (Resolve-Path -LiteralPath $IndexPath).Path
    if ([string]::Equals((Split-Path -Leaf $indexDir), "artifacts", [StringComparison]::OrdinalIgnoreCase)) {
        return (Resolve-Path -LiteralPath (Join-Path $indexDir "..")).Path
    }

    return $indexDir
}

function Resolve-ReferencedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return Join-Path $Root $Path
}

function ConvertTo-PortablePath {
    param(
        [string]$Root,
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $Path
    }
    if ([string]::IsNullOrWhiteSpace($Root)) {
        return $Path
    }

    try {
        $rootFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).Path)
        $pathFull = [System.IO.Path]::GetFullPath($Path)
        $relative = [System.IO.Path]::GetRelativePath($rootFull, $pathFull)
        if ([string]::IsNullOrWhiteSpace($relative) -or
            $relative.StartsWith("..", [StringComparison]::Ordinal) -or
            [System.IO.Path]::IsPathRooted($relative)) {
            return $Path
        }

        return $relative -replace "\\", "/"
    }
    catch {
        return $Path
    }
}

function Get-EntryScenarioIds {
    param($Entry)

    $ids = New-Object System.Collections.Generic.List[string]
    $scenarioId = [string](Get-JsonValue $Entry "scenarioId")
    if (-not [string]::IsNullOrWhiteSpace($scenarioId)) {
        $ids.Add($scenarioId) | Out-Null
    }

    foreach ($value in (Get-JsonArray $Entry "scenarioIds")) {
        $scenario = [string]$value
        if (-not [string]::IsNullOrWhiteSpace($scenario)) {
            $ids.Add($scenario) | Out-Null
        }
    }

    return @($ids.ToArray() | Select-Object -Unique)
}

function Get-EntryComparisonIds {
    param($Entry)

    $ids = New-Object System.Collections.Generic.List[string]
    foreach ($name in @("comparisonId", "comparison", "candidate", "candidateId")) {
        $comparison = ConvertTo-ComparisonId ([string](Get-JsonValue $Entry $name))
        if (-not [string]::IsNullOrWhiteSpace($comparison)) {
            $ids.Add($comparison) | Out-Null
        }
    }

    foreach ($value in (Get-JsonArray $Entry "comparisonIds")) {
        $comparison = ConvertTo-ComparisonId ([string]$value)
        if (-not [string]::IsNullOrWhiteSpace($comparison)) {
            $ids.Add($comparison) | Out-Null
        }
    }

    return @($ids.ToArray() | Select-Object -Unique)
}

function Get-TraceIndexEntries {
    param(
        [Parameter(Mandatory = $true)][string]$IndexPath,
        [string]$RootOverride,
        [string]$ComparisonFilter
    )

    $resolvedIndexPath = (Resolve-Path -LiteralPath $IndexPath).Path
    $root = Resolve-IndexRoot -IndexPath $resolvedIndexPath -RootOverride $RootOverride
    $index = Read-JsonFile $resolvedIndexPath
    $entries = New-Object System.Collections.Generic.List[object]
    $normalizedFilter = ConvertTo-ComparisonId $ComparisonFilter

    foreach ($file in (Get-JsonArray $index "files")) {
        $path = [string](Get-JsonValue $file "path")
        $summaryPath = [string](Get-JsonValue $file "summaryPath")
        $scenarioIds = @(Get-EntryScenarioIds $file)
        $comparisonIds = @(Get-EntryComparisonIds $file)

        if ($scenarioIds.Count -eq 0) {
            continue
        }
        if ($comparisonIds.Count -eq 0) {
            $comparisonIds = @("")
        }
        if (-not [string]::IsNullOrWhiteSpace($normalizedFilter) -and
            -not @($comparisonIds | Where-Object { $_ -eq $normalizedFilter }).Count) {
            continue
        }

        $resolvedTracePath = Resolve-ReferencedPath -Root $root -Path $path
        $resolvedSummaryPath = Resolve-ReferencedPath -Root $root -Path $summaryPath
        $inputPath = if (-not [string]::IsNullOrWhiteSpace($resolvedSummaryPath) -and
            (Test-Path -LiteralPath $resolvedSummaryPath -PathType Leaf)) {
            $resolvedSummaryPath
        }
        else {
            $resolvedTracePath
        }

        foreach ($scenarioId in $scenarioIds) {
            foreach ($comparisonId in $comparisonIds) {
                $entries.Add([ordered]@{
                    scenarioId = [string]$scenarioId
                    comparisonId = [string]$comparisonId
                    tracePath = $resolvedTracePath
                    summaryPath = $resolvedSummaryPath
                    inputPath = $inputPath
                    indexPath = $resolvedIndexPath
                    root = $root
                }) | Out-Null
            }
        }
    }

    return @($entries.ToArray())
}

function Add-Entry {
    param(
        [hashtable]$Map,
        $Entry
    )

    $scenario = [string]$Entry.scenarioId
    if (-not $Map.ContainsKey($scenario)) {
        $Map[$scenario] = New-Object System.Collections.Generic.List[object]
    }
    $Map[$scenario].Add($Entry) | Out-Null
}

function Invoke-TraceComparison {
    param(
        [Parameter(Mandatory = $true)][string]$CompareScript,
        [Parameter(Mandatory = $true)]$BaselineEntry,
        [Parameter(Mandatory = $true)]$CandidateEntry,
        [Parameter(Mandatory = $true)][string]$ScenarioId,
        [Parameter(Mandatory = $true)][string]$ReportPath,
        [Parameter(Mandatory = $true)][string]$BaselineLabel,
        [Parameter(Mandatory = $true)][string]$CandidateLabel,
        [Parameter(Mandatory = $true)][double]$Tolerance
    )

    if (-not (Test-Path -LiteralPath $BaselineEntry.inputPath -PathType Leaf)) {
        throw "Missing baseline trace input for scenario '$ScenarioId': $($BaselineEntry.inputPath)"
    }
    if (-not (Test-Path -LiteralPath $CandidateEntry.inputPath -PathType Leaf)) {
        throw "Missing candidate trace input for scenario '$ScenarioId': $($CandidateEntry.inputPath)"
    }

    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $CompareScript,
        "-BaselinePath", $BaselineEntry.inputPath,
        "-CandidatePath", $CandidateEntry.inputPath,
        "-BaselineLabel", $BaselineLabel,
        "-CandidateLabel", $CandidateLabel,
        "-ReportPath", $ReportPath,
        "-Tolerance", ([string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "{0:R}", $Tolerance)),
        "-NoMarkdown",
        "-JsonOnly"
    )

    $output = & powershell @args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "compare-dsp-live-diagnostics-traces.ps1 failed for scenario '$ScenarioId': $(($output | Out-String).Trim())"
    }

    $text = ($output | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return Read-JsonFile $ReportPath
    }

    return $text | ConvertFrom-Json
}

function Build-MarkdownReport {
    param($Report)

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("# DSP Live Diagnostics Matrix Comparison") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add("- Ready for review: $($Report.readyForReview)") | Out-Null
    $lines.Add("- Candidate: $($Report.candidateLabel)") | Out-Null
    $lines.Add("- Baseline: $($Report.baselineLabel)") | Out-Null
    $lines.Add("- Scenario comparisons: $($Report.candidateComparisonCount)") | Out-Null
    $lines.Add("- Regressions: $($Report.regressionCount)") | Out-Null
    $lines.Add("- Hard constraint regressions: $($Report.hardConstraintRegressionCount)") | Out-Null
    $lines.Add("- Gate failures: $($Report.gateFailureCount)") | Out-Null
    $lines.Add("- Missing values: $($Report.missingMetricValueCount)") | Out-Null
    $lines.Add("- Missing baseline scenarios: $($Report.missingBaselineCount)") | Out-Null
    $lines.Add("- Missing candidate scenarios: $($Report.missingCandidateCount)") | Out-Null
    $lines.Add("") | Out-Null

    if (@($Report.metricRegressionDetails).Count -gt 0) {
        $lines.Add("## Metric Regressions") | Out-Null
        $lines.Add("") | Out-Null
        $lines.Add("| Scenario | Metric | Baseline | Candidate | Direction | Delta | Safety |") | Out-Null
        $lines.Add("|---|---|---:|---:|---|---:|---|") | Out-Null
        foreach ($item in @($Report.metricRegressionDetails)) {
            $lines.Add("| $($item.scenarioId) | $($item.label) | $($item.baselineValue) | $($item.candidateValue) | $($item.direction) | $($item.improvementValue) | $($item.safetyClass) |") | Out-Null
        }
        $lines.Add("") | Out-Null
    }

    if (@($Report.hardConstraintRegressionDetails).Count -gt 0) {
        $lines.Add("## Hard Constraint Regressions") | Out-Null
        $lines.Add("") | Out-Null
        $lines.Add("| Scenario | Constraint | Baseline | Candidate | Delta |") | Out-Null
        $lines.Add("|---|---|---:|---:|---:|") | Out-Null
        foreach ($item in @($Report.hardConstraintRegressionDetails)) {
            $lines.Add("| $($item.scenarioId) | $($item.constraint) | $($item.baselineCount) | $($item.candidateCount) | $($item.delta) |") | Out-Null
        }
        $lines.Add("") | Out-Null
    }

    if (@($Report.gateFailureDetails).Count -gt 0) {
        $lines.Add("## Gate Failures") | Out-Null
        $lines.Add("") | Out-Null
        $lines.Add("| Scenario | Ready | OK Samples | Failed Samples | Hard Blockers |") | Out-Null
        $lines.Add("|---|---:|---:|---:|---:|") | Out-Null
        foreach ($item in @($Report.gateFailureDetails)) {
            $lines.Add("| $($item.scenarioId) | $($item.candidateReadyForBenchmarkTrace) | $($item.candidateOkSampleCount) | $($item.candidateFailedSampleCount) | $($item.candidateHardBlockerSampleCount) |") | Out-Null
        }
        $lines.Add("") | Out-Null
    }

    $lines.Add("## Scenario Summary") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add("| Scenario | Baseline | Candidate | Ready | Regressions | Gates | Missing | Report |") | Out-Null
    $lines.Add("|---|---|---|---:|---:|---:|---:|---|") | Out-Null
    foreach ($item in @($Report.scenarioComparisons)) {
        $lines.Add("| $($item.scenarioId) | $($item.baselineComparisonId) | $($item.candidateComparisonId) | $($item.readyForReview) | $($item.regressionCount) | $($item.gateFailureCount) | $($item.missingMetricValueCount) | $($item.reportPath) |") | Out-Null
    }

    return @($lines.ToArray())
}

$compareScript = Join-Path (Get-RepoRoot) "tools\compare-dsp-live-diagnostics-traces.ps1"
if (-not (Test-Path -LiteralPath $compareScript -PathType Leaf)) {
    throw "Missing trace comparator: $compareScript"
}

$resolvedBaselineIndex = (Resolve-Path -LiteralPath $BaselineIndexPath).Path
$resolvedCandidateIndex = (Resolve-Path -LiteralPath $CandidateIndexPath).Path
$bundlePath = ""
if (-not [string]::IsNullOrWhiteSpace($BundleDir)) {
    $bundlePath = (Resolve-Path -LiteralPath $BundleDir).Path
}

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    if (-not [string]::IsNullOrWhiteSpace($bundlePath)) {
        $ReportPath = Join-Path $bundlePath "artifacts\live-diagnostics-trace-comparison.json"
    }
    else {
        $candidateDir = Split-Path -Parent $resolvedCandidateIndex
        $ReportPath = Join-Path $candidateDir "dsp-live-diagnostics-trace-comparison.json"
    }
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $reportDir = Split-Path -Parent $ReportPath
    $reportName = [System.IO.Path]::GetFileNameWithoutExtension($ReportPath)
    $OutputDir = Join-Path $reportDir "$reportName.scenarios"
}

if (-not $NoMarkdown -and [string]::IsNullOrWhiteSpace($MarkdownPath)) {
    $reportDir = Split-Path -Parent $ReportPath
    $reportName = [System.IO.Path]::GetFileNameWithoutExtension($ReportPath)
    $MarkdownPath = Join-Path $reportDir "$reportName.md"
}

$baselineEntries = @(Get-TraceIndexEntries -IndexPath $resolvedBaselineIndex -RootOverride $BaselineRoot -ComparisonFilter $BaselineComparisonId)
$candidateEntries = @(Get-TraceIndexEntries -IndexPath $resolvedCandidateIndex -RootOverride $CandidateRoot -ComparisonFilter $CandidateComparisonId)

$baselineByScenario = @{}
$candidateByScenario = @{}
foreach ($entry in $baselineEntries) { Add-Entry -Map $baselineByScenario -Entry $entry }
foreach ($entry in $candidateEntries) { Add-Entry -Map $candidateByScenario -Entry $entry }

$scenarioIds = @($baselineByScenario.Keys + $candidateByScenario.Keys | Select-Object -Unique | Sort-Object)
$scenarioComparisons = New-Object System.Collections.Generic.List[object]
$missingPairs = New-Object System.Collections.Generic.List[object]

$comparisonCount = 0
$failedComparisonCount = 0
$regressionCount = 0
$improvementCount = 0
$hardConstraintRegressionCount = 0
$gateFailureCount = 0
$missingMetricValueCount = 0
$missingBaselineCount = 0
$missingCandidateCount = 0
$metricRegressionDetails = New-Object System.Collections.Generic.List[object]
$hardConstraintRegressionDetails = New-Object System.Collections.Generic.List[object]
$missingMetricDetails = New-Object System.Collections.Generic.List[object]
$gateFailureDetails = New-Object System.Collections.Generic.List[object]

foreach ($scenarioId in $scenarioIds) {
    $baselineForScenario = @()
    $candidateForScenario = @()
    if ($baselineByScenario.ContainsKey($scenarioId)) {
        $baselineForScenario = @($baselineByScenario[$scenarioId].ToArray())
    }
    if ($candidateByScenario.ContainsKey($scenarioId)) {
        $candidateForScenario = @($candidateByScenario[$scenarioId].ToArray())
    }

    if ($baselineForScenario.Count -eq 0) {
        $missingBaselineCount++
        $missingPairs.Add([ordered]@{
            scenarioId = [string]$scenarioId
            missing = "baseline"
            candidateCount = $candidateForScenario.Count
        }) | Out-Null
        continue
    }
    if ($candidateForScenario.Count -eq 0) {
        $missingCandidateCount++
        $missingPairs.Add([ordered]@{
            scenarioId = [string]$scenarioId
            missing = "candidate"
            baselineCount = $baselineForScenario.Count
        }) | Out-Null
        continue
    }

    $baselineEntry = @($baselineForScenario | Sort-Object comparisonId, inputPath)[0]
    foreach ($candidateEntry in @($candidateForScenario | Sort-Object comparisonId, inputPath)) {
        $comparisonCount++
        $safeScenario = ConvertTo-SafeName $scenarioId
        $safeCandidate = ConvertTo-SafeName $candidateEntry.comparisonId
        if ([string]::IsNullOrWhiteSpace($safeCandidate) -or $safeCandidate -eq "trace") {
            $safeCandidate = ConvertTo-SafeName $CandidateLabel
        }

        $scenarioReportPath = Join-Path $OutputDir "$safeScenario.$safeCandidate.trace-comparison.json"
        $scenarioReportDisplayPath = ConvertTo-PortablePath -Root $bundlePath -Path $scenarioReportPath
        $scenarioRecord = [ordered]@{
            scenarioId = [string]$scenarioId
            baselineComparisonId = [string]$baselineEntry.comparisonId
            candidateComparisonId = [string]$candidateEntry.comparisonId
            baselineInputPath = ConvertTo-PortablePath -Root $bundlePath -Path ([string]$baselineEntry.inputPath)
            candidateInputPath = ConvertTo-PortablePath -Root $bundlePath -Path ([string]$candidateEntry.inputPath)
            reportPath = $scenarioReportDisplayPath
            readyForReview = $false
            regressionCount = 0
            improvementCount = 0
            hardConstraintRegressionCount = 0
            gateFailureCount = 0
            missingMetricValueCount = 0
            error = $null
        }

        try {
            $scenarioReport = Invoke-TraceComparison `
                -CompareScript $compareScript `
                -BaselineEntry $baselineEntry `
                -CandidateEntry $candidateEntry `
                -ScenarioId $scenarioId `
                -ReportPath $scenarioReportPath `
                -BaselineLabel $BaselineLabel `
                -CandidateLabel $CandidateLabel `
                -Tolerance $Tolerance

            $scenarioRecord["readyForReview"] = Test-Truthy (Get-JsonValue $scenarioReport "readyForReview")
            $scenarioRecord["regressionCount"] = [int](Get-JsonValue $scenarioReport "regressionCount")
            $scenarioRecord["improvementCount"] = [int](Get-JsonValue $scenarioReport "improvementCount")
            $scenarioRecord["hardConstraintRegressionCount"] = [int](Get-JsonValue $scenarioReport "hardConstraintRegressionCount")
            $scenarioRecord["gateFailureCount"] = [int](Get-JsonValue $scenarioReport "gateFailureCount")
            $scenarioRecord["missingMetricValueCount"] = [int](Get-JsonValue $scenarioReport "missingMetricValueCount")

            foreach ($metric in (Get-JsonArray $scenarioReport "metricComparisons")) {
                $verdict = [string](Get-JsonValue $metric "verdict")
                if ($verdict -eq "regression") {
                    $metricRegressionDetails.Add([ordered]@{
                        scenarioId = [string]$scenarioId
                        baselineComparisonId = [string]$baselineEntry.comparisonId
                        candidateComparisonId = [string]$candidateEntry.comparisonId
                        metricId = [string](Get-JsonValue $metric "metricId")
                        label = [string](Get-JsonValue $metric "label")
                        direction = [string](Get-JsonValue $metric "direction")
                        safetyClass = [string](Get-JsonValue $metric "safetyClass")
                        baselineValue = Get-JsonValue $metric "baselineValue"
                        candidateValue = Get-JsonValue $metric "candidateValue"
                        improvementValue = Get-JsonValue $metric "improvementValue"
                        threshold = Get-JsonValue $metric "threshold"
                        reportPath = $scenarioReportDisplayPath
                    }) | Out-Null
                }
                elseif ($verdict -eq "missing") {
                    $missingMetricDetails.Add([ordered]@{
                        scenarioId = [string]$scenarioId
                        baselineComparisonId = [string]$baselineEntry.comparisonId
                        candidateComparisonId = [string]$candidateEntry.comparisonId
                        metricId = [string](Get-JsonValue $metric "metricId")
                        label = [string](Get-JsonValue $metric "label")
                        safetyClass = [string](Get-JsonValue $metric "safetyClass")
                        reportPath = $scenarioReportDisplayPath
                    }) | Out-Null
                }
            }

            foreach ($constraint in (Get-JsonArray $scenarioReport "hardConstraintComparisons")) {
                if ([string](Get-JsonValue $constraint "verdict") -eq "regression") {
                    $hardConstraintRegressionDetails.Add([ordered]@{
                        scenarioId = [string]$scenarioId
                        baselineComparisonId = [string]$baselineEntry.comparisonId
                        candidateComparisonId = [string]$candidateEntry.comparisonId
                        constraint = [string](Get-JsonValue $constraint "constraint")
                        baselineCount = Get-JsonValue $constraint "baselineCount"
                        candidateCount = Get-JsonValue $constraint "candidateCount"
                        delta = Get-JsonValue $constraint "delta"
                        reportPath = $scenarioReportDisplayPath
                    }) | Out-Null
                }
            }

            if ([int]$scenarioRecord["gateFailureCount"] -gt 0) {
                $gateFailureDetails.Add([ordered]@{
                    scenarioId = [string]$scenarioId
                    baselineComparisonId = [string]$baselineEntry.comparisonId
                    candidateComparisonId = [string]$candidateEntry.comparisonId
                    candidateReadyForBenchmarkTrace = Test-Truthy (Get-JsonValue $scenarioReport "candidateReadyForBenchmarkTrace")
                    candidateOkSampleCount = Get-JsonValue $scenarioReport "candidateOkSampleCount"
                    candidateFailedSampleCount = Get-JsonValue $scenarioReport "candidateFailedSampleCount"
                    candidateHardBlockerSampleCount = Get-JsonValue $scenarioReport "candidateHardBlockerSampleCount"
                    reportPath = $scenarioReportDisplayPath
                }) | Out-Null
            }
        }
        catch {
            $failedComparisonCount++
            $scenarioRecord["error"] = $_.Exception.Message
        }

        $regressionCount += [int]$scenarioRecord["regressionCount"]
        $improvementCount += [int]$scenarioRecord["improvementCount"]
        $hardConstraintRegressionCount += [int]$scenarioRecord["hardConstraintRegressionCount"]
        $gateFailureCount += [int]$scenarioRecord["gateFailureCount"]
        $missingMetricValueCount += [int]$scenarioRecord["missingMetricValueCount"]
        $scenarioComparisons.Add($scenarioRecord) | Out-Null
    }
}

$readyForReview = ($comparisonCount -gt 0 -and
    $failedComparisonCount -eq 0 -and
    $missingBaselineCount -eq 0 -and
    $missingCandidateCount -eq 0 -and
    $regressionCount -eq 0 -and
    $hardConstraintRegressionCount -eq 0 -and
    $gateFailureCount -eq 0 -and
    $missingMetricValueCount -eq 0)

$recommendations = if ($readyForReview) {
    @("Store this matrix comparison with the baseline/candidate trace indexes, offline fixture metrics, audio renders, spectrum captures, and operator notes before considering any DSP default change.")
}
else {
    @(
        "Do not graduate this DSP candidate; resolve live matrix comparison regressions or missing scenario pairs before on-air acceptance.",
        "Use the per-scenario trace comparison reports to separate DSP regressions from capture setup problems."
    )
}

$report = [ordered]@{
    schemaVersion = 1
    tool = "compare-dsp-live-diagnostics-matrix"
    compatibleTool = "compare-dsp-live-diagnostics-traces"
    generatedUtc = [DateTimeOffset]::UtcNow
    baselineLabel = $BaselineLabel
    candidateLabel = $CandidateLabel
    baselineComparisonId = ConvertTo-ComparisonId $BaselineComparisonId
    candidateComparisonId = ConvertTo-ComparisonId $CandidateComparisonId
    bundleRelativePaths = (-not [string]::IsNullOrWhiteSpace($bundlePath))
    baselineIndexPath = ConvertTo-PortablePath -Root $bundlePath -Path $resolvedBaselineIndex
    candidateIndexPath = ConvertTo-PortablePath -Root $bundlePath -Path $resolvedCandidateIndex
    reportPath = ConvertTo-PortablePath -Root $bundlePath -Path $ReportPath
    markdownPath = if ($NoMarkdown) { $null } else { ConvertTo-PortablePath -Root $bundlePath -Path $MarkdownPath }
    outputDir = ConvertTo-PortablePath -Root $bundlePath -Path $OutputDir
    tolerance = $Tolerance
    readyForReview = $readyForReview
    candidateComparisonCount = $comparisonCount
    failedComparisonCount = $failedComparisonCount
    missingBaselineCount = $missingBaselineCount
    missingCandidateCount = $missingCandidateCount
    regressionCount = $regressionCount
    improvementCount = $improvementCount
    hardConstraintRegressionCount = $hardConstraintRegressionCount
    gateFailureCount = $gateFailureCount
    missingMetricValueCount = $missingMetricValueCount
    metricRegressionDetails = @($metricRegressionDetails.ToArray())
    hardConstraintRegressionDetails = @($hardConstraintRegressionDetails.ToArray())
    gateFailureDetails = @($gateFailureDetails.ToArray())
    missingMetricDetails = @($missingMetricDetails.ToArray())
    scenarioComparisons = @($scenarioComparisons.ToArray())
    missingScenarioPairs = @($missingPairs.ToArray())
    recommendations = $recommendations
}

Write-JsonFile -Path $ReportPath -Value $report

if (-not $NoMarkdown) {
    $markdown = Build-MarkdownReport $report
    Set-Content -LiteralPath $MarkdownPath -Value $markdown -Encoding UTF8
}

if ($JsonOnly) {
    $report | ConvertTo-Json -Depth 64
}
else {
    if ($readyForReview) {
        Write-Host "DSP live diagnostics matrix comparison passed: $CandidateIndexPath"
    }
    else {
        Write-Host "DSP live diagnostics matrix comparison found issues: $CandidateIndexPath"
    }
    Write-Host "Report: $ReportPath"
    if (-not $NoMarkdown) {
        Write-Host "Markdown: $MarkdownPath"
    }
    Write-Host "Scenarios: $comparisonCount, Regressions: $regressionCount, Hard constraint regressions: $hardConstraintRegressionCount, Gate failures: $gateFailureCount, Missing values: $missingMetricValueCount"
}

if ($FailOnRegression -and -not $readyForReview) {
    exit 1
}
