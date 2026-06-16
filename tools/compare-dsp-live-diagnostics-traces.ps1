param(
    [Parameter(Mandatory = $true)]
    [string]$BaselinePath,

    [Parameter(Mandatory = $true)]
    [string]$CandidatePath,

    [string]$BaselineLabel = "current-zeus",

    [string]$CandidateLabel = "candidate-under-test",

    [string]$ReportPath = "",

    [string]$MarkdownPath = "",

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

    $json = $Value | ConvertTo-Json -Depth 48
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

    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }

        foreach ($key in @($Object.Keys)) {
            if ([string]::Equals([string]$key, $Name, [StringComparison]::OrdinalIgnoreCase)) {
                return $Object[$key]
            }
        }

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

function Get-NumericValue {
    param($Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [byte] -or $Value -is [int] -or $Value -is [long] -or
        $Value -is [float] -or $Value -is [double] -or $Value -is [decimal]) {
        return [double]$Value
    }

    $parsed = 0.0
    $style = [System.Globalization.NumberStyles]::Float -bor [System.Globalization.NumberStyles]::AllowThousands
    if ([double]::TryParse([string]$Value, $style, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return $parsed
    }

    return $null
}

function Get-StatValue {
    param(
        $Report,
        [Parameter(Mandatory = $true)][string]$Group,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $stats = Get-JsonValue $Report $Group
    if ($null -eq $stats) {
        return $null
    }

    return Get-NumericValue (Get-JsonValue $stats $Name)
}

function Get-Percent {
    param(
        $Numerator,
        $Denominator
    )

    $num = Get-NumericValue $Numerator
    $den = Get-NumericValue $Denominator
    if ($null -eq $num -or $null -eq $den -or $den -le 0.0) {
        return $null
    }

    return [Math]::Round(100.0 * $num / $den, 3)
}

function Get-CountMap {
    param($Items)

    $map = @{}
    foreach ($item in @($Items)) {
        $name = [string](Get-JsonValue $item "name")
        $count = Get-NumericValue (Get-JsonValue $item "count")
        if (-not [string]::IsNullOrWhiteSpace($name) -and $null -ne $count) {
            $map[$name] = [int]$count
        }
    }

    return $map
}

function Get-TraceSeverity {
    param([string]$Status)

    switch ($Status) {
        "endpoint-unreachable" { return 80 }
        "blocked" { return 70 }
        "final-audio-not-fresh" { return 60 }
        "rx-meters-not-fresh" { return 50 }
        "runtime-evidence-missing" { return 50 }
        "agc-movement-watch" { return 35 }
        "audio-level-watch" { return 35 }
        "evidence-trace" { return 20 }
        "ready-trace" { return 0 }
        default { return 25 }
    }
}

function Resolve-InputReport {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $extension = [System.IO.Path]::GetExtension($resolved)
    if ($extension -ieq ".jsonl") {
        $watchScript = Join-Path (Get-RepoRoot) "tools\watch-dsp-live-diagnostics.ps1"
        if (-not (Test-Path -LiteralPath $watchScript -PathType Leaf)) {
            throw "Missing watch script needed to summarize JSONL input: $watchScript"
        }

        $tempReport = Join-Path ([System.IO.Path]::GetTempPath()) ("zeus-live-trace-summary-" + [guid]::NewGuid().ToString("N") + ".json")
        $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $watchScript -InputPath $resolved -ReportPath $tempReport -JsonOnly
        if ($LASTEXITCODE -ne 0) {
            throw "watch-dsp-live-diagnostics.ps1 failed while summarizing '$resolved'."
        }

        return [ordered]@{
            path = $resolved
            summarizedFromJsonl = $true
            report = ($json | ConvertFrom-Json)
            tempReportPath = $tempReport
        }
    }

    $report = Read-JsonFile $resolved
    $tool = [string](Get-JsonValue $report "tool")
    if ($tool -ne "watch-dsp-live-diagnostics") {
        throw "Input '$resolved' must be a watch-dsp-live-diagnostics JSON report or JSONL trace; found tool '$tool'."
    }

    return [ordered]@{
        path = $resolved
        summarizedFromJsonl = $false
        report = $report
        tempReportPath = $null
    }
}

function Get-TraceMetricDefinitions {
    return @(
        [ordered]@{
            id = "failedSampleCount"
            label = "Failed samples"
            direction = "lower"
            threshold = 0.0
            safetyClass = "hard-gate"
            rationale = "Endpoint failures make trace evidence incomplete."
        },
        [ordered]@{
            id = "hardBlockerSampleCount"
            label = "Hard blocker samples"
            direction = "lower"
            threshold = 0.0
            safetyClass = "hard-gate"
            rationale = "Hard live diagnostics blockers must not increase under candidate DSP settings."
        },
        [ordered]@{
            id = "readySamplePct"
            label = "Ready sample percent"
            direction = "higher"
            threshold = 1.0
            safetyClass = "readiness"
            rationale = "Candidate traces should not reduce readiness for G2 live benchmark capture."
        },
        [ordered]@{
            id = "readinessScoreAverage"
            label = "Average readiness score"
            direction = "higher"
            threshold = 1.0
            safetyClass = "readiness"
            rationale = "Readiness score combines WDSP lifecycle, runtime alignment, live scene, and runtime evidence constraints."
        },
        [ordered]@{
            id = "agcGainMovementDb"
            label = "AGC gain movement dB"
            direction = "lower"
            threshold = 1.0
            safetyClass = "pumping"
            rationale = "Lower movement reduces the risk of audible AGC pumping during NR/AGC tuning."
        },
        [ordered]@{
            id = "audioRmsMovementDb"
            label = "Audio RMS movement dB"
            direction = "lower"
            threshold = 1.0
            safetyClass = "pumping"
            rationale = "Large final-audio RMS swings need fixture/audio review before tuning is accepted."
        },
        [ordered]@{
            id = "audioPeakMaxDbfs"
            label = "Maximum audio peak dBFS"
            direction = "lower"
            threshold = 1.0
            safetyClass = "clipping"
            rationale = "Higher dBFS peak values are closer to clipping and should not regress."
        },
        [ordered]@{
            id = "adcHeadroomMinDb"
            label = "Minimum ADC headroom dB"
            direction = "higher"
            threshold = 1.0
            safetyClass = "front-end"
            rationale = "Candidate evaluation should not consume ADC headroom."
        },
        [ordered]@{
            id = "monitorBacklogMaxSamples"
            label = "Maximum monitor backlog samples"
            direction = "lower"
            threshold = 0.0
            safetyClass = "audio-path"
            rationale = "Backlog invalidates live audio fidelity evidence."
        },
        [ordered]@{
            id = "audioFreshPct"
            label = "Audio fresh percent"
            direction = "higher"
            threshold = 1.0
            safetyClass = "freshness"
            rationale = "Fresh final audio is required before judging NR/AGC or external engines."
        },
        [ordered]@{
            id = "rxMetersFreshPct"
            label = "RX meters fresh percent"
            direction = "higher"
            threshold = 1.0
            safetyClass = "freshness"
            rationale = "Fresh RX meters are needed for AGC/headroom evidence."
        },
        [ordered]@{
            id = "squelchClosedPct"
            label = "Squelch closed percent"
            direction = "informational"
            threshold = 1.0
            safetyClass = "scenario-dependent"
            rationale = "Higher closed time is good for noise-only gating but unsafe for weak-signal preservation; review per scenario."
        },
        [ordered]@{
            id = "latencyAverageMs"
            label = "Average endpoint latency ms"
            direction = "lower"
            threshold = 5.0
            safetyClass = "tooling"
            rationale = "Diagnostics overhead should stay bounded during evidence capture."
        },
        [ordered]@{
            id = "traceStatusSeverity"
            label = "Trace status severity"
            direction = "lower"
            threshold = 0.0
            safetyClass = "hard-gate"
            rationale = "Candidate trace status should not move to a more severe watch or blocked state."
        }
    )
}

function Get-MetricValue {
    param(
        $Report,
        [Parameter(Mandatory = $true)][string]$MetricId
    )

    switch ($MetricId) {
        "failedSampleCount" { return Get-NumericValue (Get-JsonValue $Report "failedSampleCount") }
        "hardBlockerSampleCount" { return Get-NumericValue (Get-JsonValue $Report "hardBlockerSampleCount") }
        "readySamplePct" { return Get-Percent (Get-JsonValue $Report "readySampleCount") (Get-JsonValue $Report "okSampleCount") }
        "readinessScoreAverage" { return Get-StatValue $Report "readinessScore" "average" }
        "agcGainMovementDb" { return Get-StatValue $Report "agcGainDb" "movement" }
        "audioRmsMovementDb" { return Get-StatValue $Report "audioRmsDbfs" "movement" }
        "audioPeakMaxDbfs" { return Get-StatValue $Report "audioPeakDbfs" "max" }
        "adcHeadroomMinDb" { return Get-StatValue $Report "adcHeadroomDb" "min" }
        "monitorBacklogMaxSamples" { return Get-StatValue $Report "monitorBacklogSamples" "max" }
        "audioFreshPct" { return Get-Percent (Get-JsonValue $Report "audioFreshSampleCount") (Get-JsonValue $Report "runtimeEvidenceSampleCount") }
        "rxMetersFreshPct" { return Get-Percent (Get-JsonValue $Report "rxMetersFreshSampleCount") (Get-JsonValue $Report "runtimeEvidenceSampleCount") }
        "squelchClosedPct" { return Get-NumericValue (Get-JsonValue $Report "squelchClosedPct") }
        "latencyAverageMs" { return Get-StatValue $Report "latencyMs" "average" }
        "traceStatusSeverity" { return [double](Get-TraceSeverity ([string](Get-JsonValue $Report "trendStatus"))) }
        default { return $null }
    }
}

function Get-ComparisonVerdict {
    param(
        [string]$Direction,
        [double]$BaselineValue,
        [double]$CandidateValue,
        [double]$Threshold
    )

    if ($Direction -eq "informational") {
        return "informational"
    }

    $improvement = $CandidateValue - $BaselineValue
    if ($Direction -eq "lower") {
        $improvement = $BaselineValue - $CandidateValue
    }

    if ($improvement -gt $Threshold) {
        return "improvement"
    }

    if ($improvement -lt (-1.0 * $Threshold)) {
        return "regression"
    }

    return "tie"
}

function Compare-Metrics {
    param(
        $BaselineReport,
        $CandidateReport,
        [double]$GlobalTolerance
    )

    $comparisons = New-Object System.Collections.Generic.List[object]
    foreach ($metric in (Get-TraceMetricDefinitions)) {
        $metricId = [string]$metric.id
        $baselineValue = Get-MetricValue $BaselineReport $metricId
        $candidateValue = Get-MetricValue $CandidateReport $metricId
        $threshold = [Math]::Max([double]$metric.threshold, $GlobalTolerance)
        $verdict = "missing"
        $improvementValue = $null

        if ($null -ne $baselineValue -and $null -ne $candidateValue) {
            $verdict = Get-ComparisonVerdict `
                -Direction ([string]$metric.direction) `
                -BaselineValue ([double]$baselineValue) `
                -CandidateValue ([double]$candidateValue) `
                -Threshold $threshold
            $improvementValue = [double]$candidateValue - [double]$baselineValue
            if ([string]$metric.direction -eq "lower") {
                $improvementValue = [double]$baselineValue - [double]$candidateValue
            }
            $improvementValue = [Math]::Round($improvementValue, 3)
        }

        $comparisons.Add([ordered]@{
            metricId = $metricId
            label = [string]$metric.label
            direction = [string]$metric.direction
            threshold = $threshold
            safetyClass = [string]$metric.safetyClass
            baselineValue = if ($null -eq $baselineValue) { $null } else { [Math]::Round([double]$baselineValue, 3) }
            candidateValue = if ($null -eq $candidateValue) { $null } else { [Math]::Round([double]$candidateValue, 3) }
            improvementValue = $improvementValue
            verdict = $verdict
            rationale = [string]$metric.rationale
        }) | Out-Null
    }

    return @($comparisons.ToArray())
}

function Compare-HardConstraints {
    param(
        $BaselineReport,
        $CandidateReport
    )

    $baseline = Get-CountMap (Get-JsonArray $BaselineReport "hardConstraintCounts")
    $candidate = Get-CountMap (Get-JsonArray $CandidateReport "hardConstraintCounts")
    $keys = @($baseline.Keys + $candidate.Keys | Select-Object -Unique | Sort-Object)
    $comparisons = New-Object System.Collections.Generic.List[object]

    foreach ($key in $keys) {
        $baselineCount = 0
        $candidateCount = 0
        if ($baseline.ContainsKey($key)) { $baselineCount = [int]$baseline[$key] }
        if ($candidate.ContainsKey($key)) { $candidateCount = [int]$candidate[$key] }

        $verdict = "tie"
        if ($candidateCount -gt $baselineCount) {
            $verdict = "regression"
        }
        elseif ($candidateCount -lt $baselineCount) {
            $verdict = "improvement"
        }

        $comparisons.Add([ordered]@{
            constraint = [string]$key
            baselineCount = $baselineCount
            candidateCount = $candidateCount
            delta = $candidateCount - $baselineCount
            verdict = $verdict
        }) | Out-Null
    }

    return @($comparisons.ToArray())
}

function Build-MarkdownReport {
    param($Report)

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("# DSP Live Diagnostics Trace Comparison") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add("- Ready for review: $($Report.readyForReview)") | Out-Null
    $lines.Add("- Candidate: $($Report.candidateLabel)") | Out-Null
    $lines.Add("- Baseline: $($Report.baselineLabel)") | Out-Null
    $lines.Add("- Regressions: $($Report.regressionCount)") | Out-Null
    $lines.Add("- Gate failures: $($Report.gateFailureCount)") | Out-Null
    $lines.Add("- Missing values: $($Report.missingMetricValueCount)") | Out-Null
    $lines.Add("") | Out-Null

    $regressions = @($Report.metricComparisons | Where-Object { $_.verdict -eq "regression" })
    if ($regressions.Count -gt 0) {
        $lines.Add("## Metric Regressions") | Out-Null
        $lines.Add("") | Out-Null
        $lines.Add("| Metric | Baseline | Candidate | Direction | Delta |") | Out-Null
        $lines.Add("|---|---:|---:|---|---:|") | Out-Null
        foreach ($item in $regressions) {
            $lines.Add("| $($item.label) | $($item.baselineValue) | $($item.candidateValue) | $($item.direction) | $($item.improvementValue) |") | Out-Null
        }
        $lines.Add("") | Out-Null
    }

    $constraintRegressions = @($Report.hardConstraintComparisons | Where-Object { $_.verdict -eq "regression" })
    if ($constraintRegressions.Count -gt 0) {
        $lines.Add("## Hard Constraint Regressions") | Out-Null
        $lines.Add("") | Out-Null
        $lines.Add("| Constraint | Baseline | Candidate | Delta |") | Out-Null
        $lines.Add("|---|---:|---:|---:|") | Out-Null
        foreach ($item in $constraintRegressions) {
            $lines.Add("| $($item.constraint) | $($item.baselineCount) | $($item.candidateCount) | $($item.delta) |") | Out-Null
        }
        $lines.Add("") | Out-Null
    }

    $lines.Add("## Metric Summary") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add("| Metric | Baseline | Candidate | Direction | Verdict |") | Out-Null
    $lines.Add("|---|---:|---:|---|---|") | Out-Null
    foreach ($item in @($Report.metricComparisons)) {
        $lines.Add("| $($item.label) | $($item.baselineValue) | $($item.candidateValue) | $($item.direction) | $($item.verdict) |") | Out-Null
    }

    return @($lines.ToArray())
}

$baselineInput = Resolve-InputReport $BaselinePath
$candidateInput = Resolve-InputReport $CandidatePath
$baselineReport = $baselineInput.report
$candidateReport = $candidateInput.report

$metricComparisons = Compare-Metrics $baselineReport $candidateReport $Tolerance
$hardConstraintComparisons = Compare-HardConstraints $baselineReport $candidateReport

$regressionCount = @($metricComparisons | Where-Object { $_.verdict -eq "regression" }).Count
$improvementCount = @($metricComparisons | Where-Object { $_.verdict -eq "improvement" }).Count
$tieCount = @($metricComparisons | Where-Object { $_.verdict -eq "tie" }).Count
$informationalCount = @($metricComparisons | Where-Object { $_.verdict -eq "informational" }).Count
$missingCount = @($metricComparisons | Where-Object { $_.verdict -eq "missing" }).Count
$hardConstraintRegressionCount = @($hardConstraintComparisons | Where-Object { $_.verdict -eq "regression" }).Count

$candidateOkSamples = [int](Get-NumericValue (Get-JsonValue $candidateReport "okSampleCount"))
$candidateFailedSamples = [int](Get-NumericValue (Get-JsonValue $candidateReport "failedSampleCount"))
$candidateHardBlockers = [int](Get-NumericValue (Get-JsonValue $candidateReport "hardBlockerSampleCount"))
$candidateReadyTrace = Test-Truthy (Get-JsonValue $candidateReport "readyForBenchmarkTrace")

$gateFailureCount = 0
if ($candidateOkSamples -le 0) { $gateFailureCount++ }
if ($candidateFailedSamples -gt 0) { $gateFailureCount++ }
if ($candidateHardBlockers -gt 0) { $gateFailureCount++ }
if (-not $candidateReadyTrace) { $gateFailureCount++ }

$readyForReview = ($regressionCount -eq 0 -and
    $hardConstraintRegressionCount -eq 0 -and
    $gateFailureCount -eq 0 -and
    $missingCount -eq 0)

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $candidateDir = Split-Path -Parent $candidateInput.path
    if ([string]::IsNullOrWhiteSpace($candidateDir)) {
        $candidateDir = (Get-Location).Path
    }
    $ReportPath = Join-Path $candidateDir "dsp-live-diagnostics-trace-comparison.json"
}

if (-not $NoMarkdown -and [string]::IsNullOrWhiteSpace($MarkdownPath)) {
    $reportDir = Split-Path -Parent $ReportPath
    $reportName = [System.IO.Path]::GetFileNameWithoutExtension($ReportPath)
    $MarkdownPath = Join-Path $reportDir "$reportName.md"
}

$report = [ordered]@{
    schemaVersion = 1
    tool = "compare-dsp-live-diagnostics-traces"
    generatedUtc = [DateTimeOffset]::UtcNow
    baselineLabel = $BaselineLabel
    candidateLabel = $CandidateLabel
    baselinePath = $baselineInput.path
    candidatePath = $candidateInput.path
    baselineSummarizedFromJsonl = [bool]$baselineInput.summarizedFromJsonl
    candidateSummarizedFromJsonl = [bool]$candidateInput.summarizedFromJsonl
    reportPath = $ReportPath
    markdownPath = if ($NoMarkdown) { $null } else { $MarkdownPath }
    tolerance = $Tolerance
    readyForReview = $readyForReview
    baselineTrendStatus = [string](Get-JsonValue $baselineReport "trendStatus")
    candidateTrendStatus = [string](Get-JsonValue $candidateReport "trendStatus")
    candidateReadyForBenchmarkTrace = $candidateReadyTrace
    candidateOkSampleCount = $candidateOkSamples
    candidateFailedSampleCount = $candidateFailedSamples
    candidateHardBlockerSampleCount = $candidateHardBlockers
    metricComparisonCount = @($metricComparisons).Count
    improvementCount = $improvementCount
    regressionCount = $regressionCount
    hardConstraintRegressionCount = $hardConstraintRegressionCount
    gateFailureCount = $gateFailureCount
    tieCount = $tieCount
    informationalMetricCount = $informationalCount
    missingMetricValueCount = $missingCount
    metricComparisons = @($metricComparisons)
    hardConstraintComparisons = @($hardConstraintComparisons)
    recommendations = if ($readyForReview) {
        @("Store this comparison with the candidate trace, offline fixture metrics, audio renders, spectrum captures, and operator notes before considering any DSP default change.")
    }
    else {
        @(
            "Do not graduate this DSP candidate; resolve live diagnostics trace regressions before on-air acceptance.",
            "Pair this report with offline fixture metrics to distinguish real DSP regressions from capture setup problems."
        )
    }
}

Write-JsonFile -Path $ReportPath -Value $report

if (-not $NoMarkdown) {
    $markdown = Build-MarkdownReport $report
    Set-Content -LiteralPath $MarkdownPath -Value $markdown -Encoding UTF8
}

if ($JsonOnly) {
    $report | ConvertTo-Json -Depth 48
}
else {
    if ($readyForReview) {
        Write-Host "DSP live diagnostics trace comparison passed: $CandidatePath"
    }
    else {
        Write-Host "DSP live diagnostics trace comparison found issues: $CandidatePath"
    }
    Write-Host "Report: $ReportPath"
    if (-not $NoMarkdown) {
        Write-Host "Markdown: $MarkdownPath"
    }
    Write-Host "Regressions: $regressionCount, Hard constraint regressions: $hardConstraintRegressionCount, Gate failures: $gateFailureCount, Missing values: $missingCount"
}

if ($FailOnRegression -and -not $readyForReview) {
    exit 1
}
