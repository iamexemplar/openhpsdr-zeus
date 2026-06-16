param(
    [string]$BaseUrl = "http://localhost:6060",

    [int]$Samples = 15,

    [int]$IntervalMs = 1000,

    [int]$TimeoutSec = 5,

    [string]$InputPath = "",

    [string]$OutputRoot = "",

    [string]$Label = "",

    [string]$ReportPath = "",

    [string]$JsonlPath = "",

    [switch]$PlanOnly,

    [switch]$JsonOnly,

    [switch]$ContinueOnError
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Normalize-BaseUrl {
    param([Parameter(Mandatory = $true)][string]$Url)
    return $Url.TrimEnd("/")
}

function ConvertTo-SafeName {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $safe = $Value.Trim().ToLowerInvariant() -replace "[^a-z0-9._-]+", "-"
    $safe = $safe.Trim("-")
    if ($safe.Length -gt 64) {
        $safe = $safe.Substring(0, 64).Trim("-")
    }
    return $safe
}

function Read-JsonText {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Source
    )

    try {
        return $Text | ConvertFrom-Json
    }
    catch {
        throw "Failed to parse JSON from '$Source': $($_.Exception.Message)"
    }
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    return Read-JsonText -Text (Get-Content -LiteralPath $Path -Raw) -Source $Path
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

function Add-JsonLine {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    $json = $Value | ConvertTo-Json -Depth 48 -Compress
    Add-Content -LiteralPath $Path -Value $json -Encoding UTF8
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

function Add-Count {
    param(
        [hashtable]$Map,
        [string]$Name
    )

    if ([string]::IsNullOrWhiteSpace($Name)) {
        return
    }

    if (-not $Map.ContainsKey($Name)) {
        $Map[$Name] = 0
    }

    $Map[$Name] = [int]$Map[$Name] + 1
}

function ConvertTo-CountArray {
    param([hashtable]$Map)

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($key in @($Map.Keys | Sort-Object)) {
        $items.Add([ordered]@{
            name = [string]$key
            count = [int]$Map[$key]
        }) | Out-Null
    }

    return @($items.ToArray())
}

function Add-Number {
    param(
        [System.Collections.Generic.List[double]]$Target,
        $Value
    )

    $number = Get-NumericValue $Value
    if ($null -ne $number) {
        $Target.Add([double]$number) | Out-Null
    }
}

function Get-NumberStats {
    param([System.Collections.Generic.List[double]]$Values)

    if ($Values.Count -eq 0) {
        return [ordered]@{
            count = 0
            min = $null
            max = $null
            average = $null
            movement = $null
        }
    }

    $min = [double]::PositiveInfinity
    $max = [double]::NegativeInfinity
    $sum = 0.0
    foreach ($value in @($Values.ToArray())) {
        if ($value -lt $min) { $min = $value }
        if ($value -gt $max) { $max = $value }
        $sum += $value
    }

    return [ordered]@{
        count = $Values.Count
        min = [Math]::Round($min, 3)
        max = [Math]::Round($max, 3)
        average = [Math]::Round($sum / $Values.Count, 3)
        movement = [Math]::Round($max - $min, 3)
    }
}

function Test-HardConstraint {
    param([string]$Constraint)

    return $Constraint -in @(
        "wdsp-native-unloadable",
        "wdsp-inactive",
        "frontend-dsp-scene-missing",
        "frontend-dsp-scene-stale",
        "frontend-clock-skew",
        "nr4-sbnr-exports-missing",
        "nr5-spnr-exports-missing",
        "smart-nr-runtime-misaligned",
        "rx-chain-protect",
        "final-audio-not-fresh",
        "final-audio-clipping-risk",
        "adc-headroom-low"
    )
}

function Get-DiagnosticsFromSample {
    param($Sample)

    $diagnostics = Get-JsonValue $Sample "diagnostics"
    if ($null -ne $diagnostics) {
        return $diagnostics
    }

    $live = Get-JsonValue $Sample "liveDiagnostics"
    if ($null -ne $live) {
        return $live
    }

    if ($null -ne (Get-JsonValue $Sample "status") -and $null -ne (Get-JsonValue $Sample "schemaVersion")) {
        return $Sample
    }

    return $null
}

function New-SampleRecord {
    param(
        [int]$Index,
        [DateTimeOffset]$SampledUtc,
        [bool]$Ok,
        [int]$LatencyMs,
        $Diagnostics,
        [int]$StatusCode = 0,
        [string]$ErrorMessage = ""
    )

    return [ordered]@{
        schemaVersion = 1
        sampleIndex = $Index
        sampledUtc = $SampledUtc
        ok = $Ok
        statusCode = if ($StatusCode -gt 0) { $StatusCode } else { $null }
        latencyMs = if ($LatencyMs -ge 0) { $LatencyMs } else { $null }
        error = if ([string]::IsNullOrWhiteSpace($ErrorMessage)) { $null } else { $ErrorMessage }
        diagnostics = $Diagnostics
    }
}

function Read-InputSamples {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $records = New-Object System.Collections.Generic.List[object]
    $extension = [System.IO.Path]::GetExtension($resolved)

    if ($extension -ieq ".jsonl") {
        $index = 0
        foreach ($line in (Get-Content -LiteralPath $resolved)) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }

            $index++
            $sample = Read-JsonText -Text $line -Source "$resolved line $index"
            $diagnostics = Get-DiagnosticsFromSample $sample
            if ($null -eq $diagnostics) {
                throw "Input JSONL line $index does not contain a live diagnostics object."
            }

            $sampleIndex = Get-NumericValue (Get-JsonValue $sample "sampleIndex")
            if ($null -eq $sampleIndex) {
                $sampleIndex = $index
            }

            $sampledUtc = Get-JsonValue $sample "sampledUtc"
            if ($null -eq $sampledUtc) {
                $sampledUtc = [DateTimeOffset]::UtcNow
            }
            $okValue = Get-JsonValue $sample "ok"
            if ($null -eq $okValue) {
                $ok = $true
            }
            else {
                $ok = Test-Truthy $okValue
            }
            $latencyValue = Get-NumericValue (Get-JsonValue $sample "latencyMs")
            if ($null -eq $latencyValue) {
                $latencyMs = -1
            }
            else {
                $latencyMs = [int]$latencyValue
            }

            $records.Add((New-SampleRecord `
                -Index ([int]$sampleIndex) `
                -SampledUtc ([DateTimeOffset]$sampledUtc) `
                -Ok $ok `
                -LatencyMs $latencyMs `
                -Diagnostics $diagnostics)) | Out-Null
        }

        return @($records.ToArray())
    }

    $json = Read-JsonFile $resolved
    $items = @()
    $samples = Get-JsonArray $json "samples"
    if ($samples.Count -gt 0) {
        $items = @($samples)
    }
    elseif ($json -is [System.Array]) {
        $items = @($json)
    }
    else {
        $items = @($json)
    }

    $index = 0
    foreach ($item in @($items)) {
        $index++
        $diagnostics = Get-DiagnosticsFromSample $item
        if ($null -eq $diagnostics) {
            throw "Input JSON item $index does not contain a live diagnostics object."
        }

        $records.Add((New-SampleRecord `
            -Index $index `
            -SampledUtc ([DateTimeOffset]::UtcNow) `
            -Ok $true `
            -LatencyMs -1 `
            -Diagnostics $diagnostics)) | Out-Null
    }

    return @($records.ToArray())
}

function Invoke-LiveSamples {
    param(
        [Parameter(Mandatory = $true)][string]$Endpoint,
        [int]$Count,
        [int]$DelayMs,
        [int]$RequestTimeoutSec,
        [string]$LinePath
    )

    $records = New-Object System.Collections.Generic.List[object]
    for ($i = 1; $i -le $Count; $i++) {
        $sampledUtc = [DateTimeOffset]::UtcNow
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $record = $null

        try {
            $response = Invoke-WebRequest -Uri $Endpoint -Method Get -Headers @{ Accept = "application/json" } -TimeoutSec $RequestTimeoutSec
            $watch.Stop()
            $diagnostics = Read-JsonText -Text $response.Content -Source $Endpoint
            $record = New-SampleRecord `
                -Index $i `
                -SampledUtc $sampledUtc `
                -Ok $true `
                -LatencyMs ([int]$watch.ElapsedMilliseconds) `
                -StatusCode ([int]$response.StatusCode) `
                -Diagnostics $diagnostics
        }
        catch {
            $watch.Stop()
            $statusCode = 0
            if ($null -ne $_.Exception.Response) {
                try {
                    $statusCode = [int]$_.Exception.Response.StatusCode
                }
                catch {
                    $statusCode = 0
                }
            }

            $record = New-SampleRecord `
                -Index $i `
                -SampledUtc $sampledUtc `
                -Ok $false `
                -LatencyMs ([int]$watch.ElapsedMilliseconds) `
                -StatusCode $statusCode `
                -Diagnostics $null `
                -ErrorMessage $_.Exception.Message
        }

        $records.Add($record) | Out-Null
        if (-not [string]::IsNullOrWhiteSpace($LinePath)) {
            Add-JsonLine -Path $LinePath -Value $record
        }

        if ($i -lt $Count -and $DelayMs -gt 0) {
            Start-Sleep -Milliseconds $DelayMs
        }
    }

    return @($records.ToArray())
}

function New-SampleSummary {
    param($Sample)

    $diagnostics = Get-JsonValue $Sample "diagnostics"
    $runtime = Get-JsonValue $diagnostics "runtimeEvidence"

    return [ordered]@{
        sampleIndex = Get-JsonValue $Sample "sampleIndex"
        sampledUtc = Get-JsonValue $Sample "sampledUtc"
        ok = Test-Truthy (Get-JsonValue $Sample "ok")
        latencyMs = Get-JsonValue $Sample "latencyMs"
        status = [string](Get-JsonValue $diagnostics "status")
        qualityTone = [string](Get-JsonValue $diagnostics "qualityTone")
        readinessScore = Get-JsonValue $diagnostics "readinessScore"
        readyForLiveBenchmark = Test-Truthy (Get-JsonValue $diagnostics "readyForLiveBenchmark")
        runtimeStatus = [string](Get-JsonValue $runtime "status")
        audioStatus = [string](Get-JsonValue $runtime "audioStatus")
        rxMetersFresh = Test-Truthy (Get-JsonValue $runtime "rxMetersFresh")
        audioFresh = Test-Truthy (Get-JsonValue $runtime "audioFresh")
        agcGainDb = Get-JsonValue $runtime "agcGainDb"
        adcHeadroomDb = Get-JsonValue $runtime "adcHeadroomDb"
        audioRmsDbfs = Get-JsonValue $runtime "audioRmsDbfs"
        audioPeakDbfs = Get-JsonValue $runtime "audioPeakDbfs"
        squelchOpen = Test-Truthy (Get-JsonValue $runtime "squelchOpen")
        monitorBacklogSamples = Get-JsonValue $runtime "monitorBacklogSamples"
        constraints = @(Get-JsonArray $diagnostics "constraints")
    }
}

function Build-Report {
    param(
        [object[]]$SampleRecords,
        [string]$SourceMode,
        [string]$Endpoint,
        [string]$SourcePath,
        [string]$LinePath,
        [DateTimeOffset]$StartedUtc,
        [DateTimeOffset]$CompletedUtc
    )

    $statusCounts = @{}
    $toneCounts = @{}
    $runtimeStatusCounts = @{}
    $audioStatusCounts = @{}
    $constraintCounts = @{}
    $hardConstraintCounts = @{}
    $latencies = New-Object System.Collections.Generic.List[double]
    $readinessScores = New-Object System.Collections.Generic.List[double]
    $agcValues = New-Object System.Collections.Generic.List[double]
    $headroomValues = New-Object System.Collections.Generic.List[double]
    $rmsValues = New-Object System.Collections.Generic.List[double]
    $peakValues = New-Object System.Collections.Generic.List[double]
    $backlogValues = New-Object System.Collections.Generic.List[double]
    $sampleSummaries = New-Object System.Collections.Generic.List[object]
    $recommendations = New-Object System.Collections.Generic.List[string]

    $okCount = 0
    $failedCount = 0
    $readyCount = 0
    $runtimeCount = 0
    $rxMetersFreshCount = 0
    $audioFreshCount = 0
    $txMonitorCount = 0
    $squelchEnabledCount = 0
    $squelchClosedCount = 0
    $squelchTailCount = 0
    $hardBlockerSampleCount = 0

    foreach ($sample in @($SampleRecords)) {
        if (-not (Test-Truthy (Get-JsonValue $sample "ok"))) {
            $failedCount++
            $sampleSummaries.Add((New-SampleSummary $sample)) | Out-Null
            continue
        }

        $okCount++
        Add-Number $latencies (Get-JsonValue $sample "latencyMs")
        $diagnostics = Get-JsonValue $sample "diagnostics"
        $runtime = Get-JsonValue $diagnostics "runtimeEvidence"
        $status = [string](Get-JsonValue $diagnostics "status")
        $tone = [string](Get-JsonValue $diagnostics "qualityTone")
        Add-Count $statusCounts $status
        Add-Count $toneCounts $tone
        Add-Number $readinessScores (Get-JsonValue $diagnostics "readinessScore")

        if (Test-Truthy (Get-JsonValue $diagnostics "readyForLiveBenchmark")) {
            $readyCount++
        }

        $sampleHasHardBlocker = $false
        foreach ($constraint in (Get-JsonArray $diagnostics "constraints")) {
            $constraintText = [string]$constraint
            Add-Count $constraintCounts $constraintText
            if (Test-HardConstraint $constraintText) {
                Add-Count $hardConstraintCounts $constraintText
                $sampleHasHardBlocker = $true
            }
        }

        if ($sampleHasHardBlocker) {
            $hardBlockerSampleCount++
        }

        foreach ($action in (Get-JsonArray $diagnostics "recommendedActions")) {
            $actionText = [string]$action
            if (-not [string]::IsNullOrWhiteSpace($actionText) -and -not $recommendations.Contains($actionText)) {
                $recommendations.Add($actionText) | Out-Null
            }
        }

        if ($null -ne $runtime) {
            $runtimeCount++
            Add-Count $runtimeStatusCounts ([string](Get-JsonValue $runtime "status"))
            Add-Count $audioStatusCounts ([string](Get-JsonValue $runtime "audioStatus"))
            Add-Number $agcValues (Get-JsonValue $runtime "agcGainDb")
            Add-Number $headroomValues (Get-JsonValue $runtime "adcHeadroomDb")
            Add-Number $rmsValues (Get-JsonValue $runtime "audioRmsDbfs")
            Add-Number $peakValues (Get-JsonValue $runtime "audioPeakDbfs")
            Add-Number $backlogValues (Get-JsonValue $runtime "monitorBacklogSamples")

            if (Test-Truthy (Get-JsonValue $runtime "rxMetersFresh")) {
                $rxMetersFreshCount++
            }
            if (Test-Truthy (Get-JsonValue $runtime "audioFresh")) {
                $audioFreshCount++
            }
            if (Test-Truthy (Get-JsonValue $runtime "txMonitorRequested")) {
                $txMonitorCount++
            }
            if (Test-Truthy (Get-JsonValue $runtime "squelchEnabled")) {
                $squelchEnabledCount++
                if (-not (Test-Truthy (Get-JsonValue $runtime "squelchOpen"))) {
                    $squelchClosedCount++
                }
            }
            if (Test-Truthy (Get-JsonValue $runtime "squelchTailActive")) {
                $squelchTailCount++
            }
        }

        $sampleSummaries.Add((New-SampleSummary $sample)) | Out-Null
    }

    $agcStats = Get-NumberStats $agcValues
    $headroomStats = Get-NumberStats $headroomValues
    $rmsStats = Get-NumberStats $rmsValues
    $peakStats = Get-NumberStats $peakValues
    $backlogStats = Get-NumberStats $backlogValues

    $summaryRecommendations = New-Object System.Collections.Generic.List[string]
    if ($okCount -eq 0) {
        $summaryRecommendations.Add("Start Zeus and verify /api/dsp/live-diagnostics is reachable before collecting live DSP evidence.") | Out-Null
    }
    if ($failedCount -gt 0) {
        $summaryRecommendations.Add("Repeat the trace after endpoint failures are resolved; missing samples weaken AGC and audio movement evidence.") | Out-Null
    }
    if ($hardBlockerSampleCount -gt 0) {
        $summaryRecommendations.Add("Resolve hard live diagnostics blockers before using this trace as G2 acceptance evidence.") | Out-Null
    }
    if ($runtimeCount -lt $okCount) {
        $summaryRecommendations.Add("Upgrade or restart the backend so every live diagnostics sample includes runtimeEvidence.") | Out-Null
    }
    if ($audioFreshCount -lt $runtimeCount) {
        $summaryRecommendations.Add("Restore fresh final audio before judging NR/AGC or external speech engines.") | Out-Null
    }
    if ($rxMetersFreshCount -lt $runtimeCount) {
        $summaryRecommendations.Add("Restore fresh RXA meters before using AGC gain or ADC headroom trends.") | Out-Null
    }
    if ([int]$agcStats["count"] -gt 1 -and [double]$agcStats["movement"] -gt 12.0) {
        $summaryRecommendations.Add("AGC gain moved more than 12 dB during the trace; run the agc-level-step fixture and listen for pumping before tuning NR.") | Out-Null
    }
    if ([int]$rmsStats["count"] -gt 1 -and [double]$rmsStats["movement"] -gt 10.0) {
        $summaryRecommendations.Add("Final audio RMS moved more than 10 dB during the trace; pair this JSONL with audio render evidence before approving changes.") | Out-Null
    }
    if ([int]$backlogStats["count"] -gt 0 -and [double]$backlogStats["max"] -gt 0) {
        $summaryRecommendations.Add("Monitor backlog appeared during the trace; drain or stop monitor injection before judging live audio fidelity.") | Out-Null
    }
    if ($summaryRecommendations.Count -eq 0) {
        $summaryRecommendations.Add("Store this JSONL trace with the modernization bundle and compare it with fixture metrics before changing DSP defaults.") | Out-Null
    }

    $trendStatus = "evidence-trace"
    if ($okCount -eq 0) {
        $trendStatus = "endpoint-unreachable"
    }
    elseif ($hardBlockerSampleCount -gt 0) {
        $trendStatus = "blocked"
    }
    elseif ($runtimeCount -lt $okCount) {
        $trendStatus = "runtime-evidence-missing"
    }
    elseif ($audioFreshCount -lt $runtimeCount) {
        $trendStatus = "final-audio-not-fresh"
    }
    elseif ($rxMetersFreshCount -lt $runtimeCount) {
        $trendStatus = "rx-meters-not-fresh"
    }
    elseif ([int]$agcStats["count"] -gt 1 -and [double]$agcStats["movement"] -gt 12.0) {
        $trendStatus = "agc-movement-watch"
    }
    elseif ([int]$rmsStats["count"] -gt 1 -and [double]$rmsStats["movement"] -gt 10.0) {
        $trendStatus = "audio-level-watch"
    }
    elseif ($readyCount -eq $okCount) {
        $trendStatus = "ready-trace"
    }

    $readyTrace = ($okCount -gt 0 -and
        $failedCount -eq 0 -and
        $hardBlockerSampleCount -eq 0 -and
        $runtimeCount -eq $okCount -and
        $audioFreshCount -eq $runtimeCount -and
        $rxMetersFreshCount -eq $runtimeCount)

    $durationMs = [int]($CompletedUtc - $StartedUtc).TotalMilliseconds
    $squelchClosedPct = 0.0
    if ($squelchEnabledCount -gt 0) {
        $squelchClosedPct = [Math]::Round(100.0 * $squelchClosedCount / $squelchEnabledCount, 1)
    }

    return [ordered]@{
        schemaVersion = 1
        tool = "watch-dsp-live-diagnostics"
        generatedUtc = $CompletedUtc
        sourceMode = $SourceMode
        endpoint = $Endpoint
        inputPath = if ([string]::IsNullOrWhiteSpace($SourcePath)) { $null } else { $SourcePath }
        jsonlPath = if ([string]::IsNullOrWhiteSpace($LinePath)) { $null } else { $LinePath }
        startedUtc = $StartedUtc
        completedUtc = $CompletedUtc
        durationMs = $durationMs
        sampleCount = @($SampleRecords).Count
        okSampleCount = $okCount
        failedSampleCount = $failedCount
        readySampleCount = $readyCount
        readyForBenchmarkTrace = $readyTrace
        trendStatus = $trendStatus
        hardBlockerSampleCount = $hardBlockerSampleCount
        runtimeEvidenceSampleCount = $runtimeCount
        rxMetersFreshSampleCount = $rxMetersFreshCount
        audioFreshSampleCount = $audioFreshCount
        txMonitorSampleCount = $txMonitorCount
        squelchEnabledSampleCount = $squelchEnabledCount
        squelchClosedSampleCount = $squelchClosedCount
        squelchClosedPct = $squelchClosedPct
        squelchTailSampleCount = $squelchTailCount
        latencyMs = Get-NumberStats $latencies
        readinessScore = Get-NumberStats $readinessScores
        agcGainDb = $agcStats
        adcHeadroomDb = $headroomStats
        audioRmsDbfs = $rmsStats
        audioPeakDbfs = $peakStats
        monitorBacklogSamples = $backlogStats
        statusCounts = @(ConvertTo-CountArray $statusCounts)
        qualityToneCounts = @(ConvertTo-CountArray $toneCounts)
        runtimeStatusCounts = @(ConvertTo-CountArray $runtimeStatusCounts)
        audioStatusCounts = @(ConvertTo-CountArray $audioStatusCounts)
        constraintCounts = @(ConvertTo-CountArray $constraintCounts)
        hardConstraintCounts = @(ConvertTo-CountArray $hardConstraintCounts)
        recommendations = @($summaryRecommendations.ToArray())
        liveRecommendedActions = @($recommendations.ToArray())
        sampleSummaries = @($sampleSummaries.ToArray())
    }
}

if ($Samples -lt 1) {
    throw "Samples must be at least 1."
}
if ($IntervalMs -lt 0) {
    throw "IntervalMs must be greater than or equal to 0."
}
if ($TimeoutSec -lt 1) {
    throw "TimeoutSec must be at least 1."
}

$base = Normalize-BaseUrl $BaseUrl
$endpoint = "$base/api/dsp/live-diagnostics"

if ($PlanOnly) {
    [ordered]@{
        schemaVersion = 1
        tool = "watch-dsp-live-diagnostics"
        mode = "plan-only"
        endpoint = $endpoint
        samples = $Samples
        intervalMs = $IntervalMs
        outputs = @(
            "JSONL per-sample diagnostics trace",
            "JSON summary with runtime evidence, blockers, and AGC/audio/headroom movement"
        )
        example = "powershell -NoProfile -ExecutionPolicy Bypass -File tools\watch-dsp-live-diagnostics.ps1 -BaseUrl $base -Samples 60 -IntervalMs 1000 -Label g2-nr5-weak-cw"
        offlineExample = "powershell -NoProfile -ExecutionPolicy Bypass -File tools\watch-dsp-live-diagnostics.ps1 -InputPath captures\dsp-live-diagnostics\trace.jsonl -JsonOnly"
        notes = @(
            "Read-only: the tool only calls GET /api/dsp/live-diagnostics.",
            "Use traces as runtime context beside offline fixture metrics, audio renders, spectrum captures, and operator notes.",
            "A ready trace does not approve changing DSP defaults by itself."
        )
    } | ConvertTo-Json -Depth 16
    exit 0
}

$repoRoot = Get-RepoRoot
$startedUtc = [DateTimeOffset]::UtcNow
$safeLabel = ConvertTo-SafeName $Label

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot "captures\dsp-live-diagnostics"
}

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $stamp = $startedUtc.ToString("yyyyMMddTHHmmssfffZ")
    if ([string]::IsNullOrWhiteSpace($safeLabel)) {
        $captureName = $stamp
    }
    else {
        $captureName = "$stamp-$safeLabel"
    }

    $captureDir = Join-Path $OutputRoot $captureName
    if ([string]::IsNullOrWhiteSpace($ReportPath)) {
        $ReportPath = Join-Path $captureDir "live-diagnostics-watch.json"
    }
    if ([string]::IsNullOrWhiteSpace($JsonlPath)) {
        $JsonlPath = Join-Path $captureDir "live-diagnostics-trace.jsonl"
    }

    $sampleRecords = Invoke-LiveSamples -Endpoint $endpoint -Count $Samples -DelayMs $IntervalMs -RequestTimeoutSec $TimeoutSec -LinePath $JsonlPath
    $completedUtc = [DateTimeOffset]::UtcNow
    $report = Build-Report `
        -SampleRecords $sampleRecords `
        -SourceMode "live-endpoint" `
        -Endpoint $endpoint `
        -SourcePath "" `
        -LinePath $JsonlPath `
        -StartedUtc $startedUtc `
        -CompletedUtc $completedUtc
}
else {
    $resolvedInputPath = (Resolve-Path -LiteralPath $InputPath).Path
    if ([string]::IsNullOrWhiteSpace($ReportPath)) {
        $inputDir = Split-Path -Parent $resolvedInputPath
        $inputName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedInputPath)
        $ReportPath = Join-Path $inputDir "$inputName.summary.json"
    }

    $sampleRecords = Read-InputSamples -Path $resolvedInputPath
    $completedUtc = [DateTimeOffset]::UtcNow
    $report = Build-Report `
        -SampleRecords $sampleRecords `
        -SourceMode "input-file" `
        -Endpoint $endpoint `
        -SourcePath $resolvedInputPath `
        -LinePath $resolvedInputPath `
        -StartedUtc $startedUtc `
        -CompletedUtc $completedUtc
}

Write-JsonFile -Path $ReportPath -Value $report

if ($JsonOnly) {
    $report | ConvertTo-Json -Depth 48
}
else {
    Write-Host "DSP live diagnostics watch summary: $ReportPath"
    if (-not [string]::IsNullOrWhiteSpace($JsonlPath)) {
        Write-Host "Trace: $JsonlPath"
    }
    Write-Host "Status: $($report["trendStatus"])"
    Write-Host "Samples: $($report["okSampleCount"]) ok, $($report["failedSampleCount"]) failed, $($report["hardBlockerSampleCount"]) with hard blockers"
    Write-Host "AGC movement dB: $($report["agcGainDb"]["movement"]), audio RMS movement dB: $($report["audioRmsDbfs"]["movement"]), min ADC headroom dB: $($report["adcHeadroomDb"]["min"])"
}

if (-not $ContinueOnError -and [int]$report["okSampleCount"] -eq 0) {
    exit 1
}
