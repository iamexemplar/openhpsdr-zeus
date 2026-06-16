# WDSP Lineage and Parity Analysis

**Status:** Phase 1 foundation.
**Primary target:** ANAN G2 first-pass validation; cross-radio validation required before any
"best in class" DSP claim.
**Behavior authority:** Warren Pratt's WDSP Guide Rev 1.23 plus Thetis WDSP behavior.

## Sources

| Source | Role | Current observation |
|---|---|---|
| `Documentation/Radio/WDSP Guide, Rev 1.23.pdf` in the local Thetis tree | API and signal-chain authority | Rev 1.23, Warren C. Pratt, NR0V; documents channel lifecycle, RXA, TXA, analyzer, resamplers, PureSignal, CFC, VOX/DEXP, and external WDSP blocks. |
| `C:\Users\Admin\Desktop\Thetis-master\Project Files\Source\wdsp` | Reference implementation | Treat as the authoritative OpenHPSDR WDSP behavior when Zeus and Thetis differ unless Zeus has an explicit documented product-policy reason. |
| `https://github.com/g0orx/wdsp` | Historical lineage | Commit `49084f50c583a73644e03bcb56443fa9deb327de`, dated 2022-01-17. Useful for old Linux/Android port context, not an update source for Zeus. |
| `native/wdsp` | Zeus vendored WDSP | Contains Thetis-era components plus Zeus build/export shims and local experimental extensions. |
| `Zeus.Dsp/Wdsp` and `Zeus.Server.Hosting/DspPipelineService.cs` | Managed DSP integration | Defines the P/Invoke, channel lifecycle, pipeline policy, telemetry, and operator-facing behavior. |

## Delta Classification

| Area | Classification | Notes |
|---|---|---|
| RXA/TXA stage order | Thetis parity | Zeus must preserve WDSP's RXA and TXA stage order. Stage moves require measured evidence and an explicit compatibility decision. |
| `OpenChannel(... state: 0)` followed by explicit `SetChannelState(id, 1, 0)` | Thetis parity | Required by WDSP channel lifecycle. A stale `-400` RX meter is a regression signal that exchange/exec state did not run. |
| RX filter updates through `SetRXABandpassFreqs`, `RXANBPSetFreqs`, and `SetRXASNBAOutputBandwidth` | Thetis parity | `SetRXABandpassFreqs` alone is insufficient for the active SSB path. |
| AGC mode/custom controls, squelch, TX leveling, CFC, and high-rate sample ladder work | Thetis parity with Zeus integration | Existing parity work should be validated against the guide and Thetis before any modernization tuning. |
| CMake build, runtime native packaging, export wrappers, and fallback symbol probing | Port/build support | These are expected Zeus differences and should not be "reverted to Thetis" unless they are proven defective. |
| RX audio leveler, adaptive squelch, Auto-AGC policy, Smart NR, and frontend chain-health logic | Zeus product policy | These sit above WDSP. They may improve operation, but must be measured separately from WDSP parity. |
| SBNR/RNNR bindings and capability guards | Thetis parity plus portability | Thetis contains SBNR/RNNR-era code that the older g0orx tree lacks. Zeus should keep graceful fallback when native symbols are absent. |
| NR5/SPNR native stage and diagnostics | Experimental enhancement | Preserve as active local work. It remains opt-in/experimental until benchmark and on-air evidence prove it. |
| Broad native WDSP source drift from Thetis | Needs audit | Key files differ in line count and hash. Classify each delta before importing, deleting, or refactoring native code. |
| Crashing broad NR combinatorial test mode | Likely lifecycle/test defect | Keep focused lifecycle tests as gates; run broad combinatorics only as an opt-in diagnostic until the native lifecycle issue is isolated. |

## RXA Audit Map

The WDSP RXA chain is the main receive engine. Zeus must validate the following before tuning:

1. Channel lifecycle: create stopped, configure, start worker, then `SetChannelState(id, 1, 0)`.
2. Buffer/rate model: RXA input/dsp block sizes, sample-rate conversion, analyzer rate, and G2 high-rate DDC behavior.
3. Front-end stages: frequency shift, input resample, generators, ADC meter, pre-noise blankers, and first bandpass.
4. Demod and squelch: SSQL/AMSQ/FMSQ mode selection and adaptive squelch interaction.
5. Post-demod conditioning: SNBA, EQ, ANF/ANR, EMNR, RNNR, SBNR, SPNR, AGC, notches, carrier block, CW filters, patch panel, and output resample.
6. Meter contract: ADC, signal, AGC gain/envelope, NR diagnostics, and frontend telemetry must agree on units and sentinel behavior.

## TXA Audit Map

The TXA chain must be treated as a safety-critical path because level, ALC, and PureSignal changes
can affect transmitted spectral cleanliness.

1. Channel lifecycle and MOX state transitions, including RXA damp-down/re-arm.
2. Input block shape: mic sample rate, TXA profile, P2 high-rate CFIR path, and output IQ block sizing.
3. Gain stages: panel gain, phase rotator, mic meter, downward expander, EQ, leveler, CFC, compressor, overshoot control, ALC, modulation, and output meter.
4. PureSignal: `calcc`/`iqc` state, siphon/analyzer placement, feedback safety, and bypass behavior.
5. Verification: TX two-tone, voice-like audio, clipping, ALC movement, CFC behavior, and PureSignal-disabled fallback.

## Managed Seam Parity Matrix

| Subsystem | Zeus seam | Current parity posture | Next check |
|---|---|---|---|
| Channel lifecycle | `WdspDspEngine.OpenChannel`, `OpenTxChannel`, `SetMox`, `NativeMethods.OpenChannel`, `SetChannelState` | Matches WDSP's stopped-open/configure/start-state pattern; MOX toggles RXA/TXA state explicitly. | Add a lifecycle benchmark that records meter escape and audio drain after each state transition. |
| RX buffer/rate | RXA constants in `WdspDspEngine`, `FeedIq`, worker exchange path | Fixed RXA block sizing is intentional; high G2 DDC rates need bench proof. | Capture CPU, underrun, analyzer cadence, and audio drain at 384/768/1536 kHz on G2. |
| RX filters | `SetFilter`, `ApplyBandpassForMode`, `NativeMethods.SetRXABandpassFreqs`, `RXANBPSetFreqs`, `SetRXASNBAOutputBandwidth` | Uses the three active WDSP stages needed for SSB parity. | Audit tap count, min-phase, and per-mode width caps against Thetis. |
| AGC | `SetAgcMode`, `SetAgcTop`, Auto-AGC path in `RadioService` | Thetis mode/custom controls exist; Zeus adds an operator policy layer for Auto-AGC. | Add AGC pumping/loudness benchmark from the `AgcStep` fixture. |
| Squelch | `SetSquelch`, adaptive squelch in `DspPipelineService` | WDSP SSQL/AMSQ/FMSQ are mode-aware; Zeus adds adaptive server policy. | Use `SquelchTransition` fixture to measure open/close latency and false-open behavior. |
| NR/NB | `SetNoiseReduction`, NR1/NR2/NR4/NR5 bindings, NB1/NB2/SNB setters | Mutual exclusion is enforced in the engine; SBNR and SPNR are capability guarded. | Promote NR5 diagnostic tests into shared benchmark reports and add NR-off/NR-on comparisons. |
| RX audio policy | `DspPipelineService` audio leveler and sanitizer | Zeus policy above WDSP, not Thetis parity. | Measure post-WDSP level stability separately from WDSP AGC so tuning does not mask a WDSP regression. |
| TX leveler/CFC/compressor/ALC | `SetTxLeveling`, CFC setters, TXA processing path | Leveler/CFC wiring exists; TX compressor/ALC behavior must stay Thetis-compatible. | Add TX two-tone and voice-like benchmark runner through `ProcessTxBlock`. |
| PureSignal/CFIR | PureSignal setters, feedback display analyzer, TXA profile selection | Safety-sensitive parity area; no modernization should alter default PureSignal state. | Validate PureSignal disabled/enabled bypass behavior on G2 before any TX profile change. |
| Capability reporting | native export probes and diagnostics DTOs | SBNR/SPNR fallbacks are present; external engines not integrated. | Add an opt-in capability surface only after an external engine passes licensing/package review. |

## Benchmark Foundation

The first benchmark layer is deterministic and offline. It does not change runtime behavior and does
not require a radio. It must generate stable fixtures for:

- Weak CW/carrier.
- SSB-like speech/formant content.
- Fading carrier.
- Impulse noise.
- Strong adjacent signal.
- Noise-only gating.
- AGC level step/pumping checks.
- Squelch open/close transitions.
- TX two-tone.
- TX voice-like audio.

Metrics captured by the foundation are intentionally primitive but stable: RMS, peak, crest factor,
DC offset, windowed RMS movement, and coherent tone power. Later WDSP-backed benchmark runners can
reuse the fixtures and add SINAD-style metrics, artifact scores, per-stage timing, allocation, and
hardware capture comparisons.

The benchmark acceptance surface is `/api/dsp/benchmark-plan`. It publishes the required scenario
catalog for live tools and scripts: frontend scene freshness, weak CW/carrier preservation,
SSB-like speech, fading carrier, impulse noise, strong adjacent signal, noise-only gating, AGC
level steps, squelch transitions, TX two-tone, TX voice-like audio, PureSignal-safe bypass, and
WDSP channel lifecycle. Each scenario lists required comparisons, metrics, artifacts, and failure
gates. This endpoint is the checklist for G2 capture sessions and later cross-radio validation.

The companion metric semantics surface is `/api/dsp/benchmark-metric-catalog`. It assigns each
required metric a normalized ID, direction (`higher`, `lower`, or `informational`), unit hint,
safety class, rationale, and related scenario IDs. Capture bundles save it as
`benchmark-metric-catalog.json`; comparison tooling prefers that captured catalog before falling
back to built-in metric directions.

The capture manifest surface is `/api/dsp/benchmark-capture-manifest`. It combines the current live
diagnostics state with the benchmark plan into a concrete evidence checklist: scenario IDs to run,
required endpoint snapshots, offline fixture metrics, audio/spectrum artifacts, preflight checks,
stop conditions, and operator notes. A manifest can be saved with a G2 session to prove what evidence
was required at the time of capture.

The one-call evidence bundle is `/api/dsp/modernization-snapshot`. It nests the current Smart NR
condition, live diagnostics, benchmark plan, capture manifest, and external-engine candidate catalog
with an evidence completeness score and missing-evidence list. Capture tools should save this once
at the start and end of a G2 session so later review can reconstruct the exact readiness state.
The local helper `tools/capture-dsp-modernization-bundle.ps1` captures that endpoint plus the
supporting diagnostics endpoints into an ignored `captures/dsp-modernization/<timestamp>/` folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\capture-dsp-modernization-bundle.ps1 -BaseUrl http://localhost:6060 -Label g2-nr5-before
powershell -NoProfile -ExecutionPolicy Bypass -File tools\watch-dsp-live-diagnostics.ps1 -BaseUrl http://localhost:6060 -Samples 60 -IntervalMs 1000 -Label g2-nr5-weak-cw
powershell -NoProfile -ExecutionPolicy Bypass -File tools\new-dsp-artifact-manifest.ps1 -BundleDir captures\dsp-modernization\<timestamp>
powershell -NoProfile -ExecutionPolicy Bypass -File tools\audit-wdsp-native-symbols.ps1 -ReportPath captures\dsp-modernization\<timestamp>\artifacts\wdsp-native-symbol-audit.json -RequireBinaryExports
powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-dsp-live-diagnostics-matrix.ps1 -BundleDir captures\dsp-modernization\<timestamp> -ComparisonId current-zeus -Samples 60 -IntervalMs 1000
powershell -NoProfile -ExecutionPolicy Bypass -File tools\compare-dsp-live-diagnostics-traces.ps1 -BaselinePath captures\dsp-modernization\<timestamp>\artifacts\live-diagnostics-baseline.jsonl -CandidatePath captures\dsp-modernization\<timestamp>\artifacts\live-diagnostics-trace.jsonl -FailOnRegression
powershell -NoProfile -ExecutionPolicy Bypass -File tools\compare-dsp-fixture-metrics.ps1 -BundleDir captures\dsp-modernization\<timestamp> -FailOnRegression
powershell -NoProfile -ExecutionPolicy Bypass -File tools\validate-dsp-modernization-bundle.ps1 -BundleDir captures\dsp-modernization\<timestamp>
powershell -NoProfile -ExecutionPolicy Bypass -File tools\validate-dsp-modernization-bundle.ps1 -BundleDir captures\dsp-modernization\<timestamp> -RequireArtifactFiles
```

The scaffold generator writes `artifact-manifest.template.json` by default and includes required
non-endpoint artifacts; pass `-IncludeOptionalArtifacts` when a review needs optional evidence
placeholders too. Fill the required paths with offline metrics, audio/spectrum evidence indexes,
TX/PureSignal traces, and operator notes, then copy or regenerate it as `artifact-manifest.json`
before treating a capture as acceptance evidence. Without `-RequireArtifactFiles`, the validator
warns when this manifest is absent and still checks endpoint JSON; with `-RequireArtifactFiles`, it
fails missing required offline metrics, audio renders, spectrum captures, operator notes,
WDSP native symbol audits, and TX/PureSignal traces. The required
`wdsp-native-symbol-audit` artifact must be generated by
`tools/audit-wdsp-native-symbols.ps1` with binary export evaluation enabled; strict validation
rejects reports with missing required source/export symbols, signature mismatches, or
`readyForReview=false`. The scaffold also adds the generated
`fixture-metric-comparison-report` artifact at `dsp-fixture-metric-comparison.json`; strict
validation requires it and rejects reports with regressions, failed gates, missing current-Zeus or
Thetis baselines, missing candidate coverage, or missing metric values.

Use `tools/watch-dsp-live-diagnostics.ps1` during G2 scenario windows when the question is
runtime stability rather than a single snapshot. It samples `/api/dsp/live-diagnostics`, writes a
JSONL trace plus a summary report, and tracks hard blockers, AGC gain movement, final-audio RMS/peak
movement, minimum ADC headroom, squelch closed percentage, TX-monitor coupling, and monitor backlog.
These traces are optional artifact evidence and do not approve changing defaults by themselves. Use
`tools/compare-dsp-live-diagnostics-traces.ps1` to compare candidate windows against a current-Zeus
or Thetis-parity baseline; it rejects regressions in blockers, readiness, AGC/audio movement,
clipping-risk proxy peaks, ADC headroom, monitor backlog, and diagnostic freshness before any
on-air acceptance claim.

Use `tools/run-dsp-live-diagnostics-matrix.ps1` when a G2 session needs repeatable live windows
across several benchmark scenarios. It delegates to the single-window watcher, writes one JSONL trace
and summary per scenario, and produces `artifacts/live-diagnostics-trace-index.json` for optional
`trace` artifact validation. Use `-ComparisonId current-zeus` or `thetis-parity` for baseline
windows and candidate IDs such as `nr5-spnr` for opt-in candidate windows. Pass
`-IncludeOptionalArtifacts` to `tools/new-dsp-artifact-manifest.ps1` when the bundle should validate
the optional `live-diagnostics-trace-index` scenario/comparison coverage. If an artifact captures
only one comparison, add `comparisonIds` to that artifact-manifest entry so strict validation checks
the captured comparison instead of requiring every benchmark-plan comparison in the same file.

Strict bundle validation also checks the hardware evidence chain. `benchmark-plan.json` must keep
`firstHardwareTarget` at `G2`, `benchmark-capture-manifest.json` must carry the same
`hardwareTarget`, and `hardware-diagnostics.json` must show a connected G2-class OrionMkII context
with a G2/G2_1K variant before the bundle is accepted as first-cycle hardware evidence. Use
`-AllowPreflight` only for dry-run captures; it downgrades readiness gaps to warnings but does not
turn them into acceptance evidence.

Example:

```json
{
  "schemaVersion": 1,
  "artifacts": [
    {
      "id": "offline-fixture-metrics",
      "kind": "metrics-json",
      "path": "artifacts/offline-fixture-metrics.json",
      "required": true,
      "scenarioIds": ["weak-cw-carrier", "ssb-like-speech"]
    },
    {
      "id": "wdsp-native-symbol-audit",
      "kind": "native-audit-json",
      "path": "artifacts/wdsp-native-symbol-audit.json",
      "required": true,
      "scenarioIds": ["weak-cw-carrier", "ssb-like-speech"]
    },
    {
      "id": "audio-render-before-after",
      "kind": "audio",
      "path": "artifacts/audio-render-before-after.json",
      "required": true,
      "scenarioIds": ["weak-cw-carrier"]
    },
    {
      "id": "operator-notes",
      "kind": "notes",
      "path": "artifacts/operator-notes.md",
      "required": true,
      "scenarioIds": ["weak-cw-carrier", "ssb-like-speech"]
    }
  ]
}
```

For `audio`, `spectrum`, and `trace` artifacts, the generated path is a JSON index. Its `files`
array must point to bundle-relative leaf evidence files and tag each file with `scenarioId` or
`scenarioIds` plus `comparison`, `comparisonId`, or `candidate`; strict validation checks that each
listed file exists, is non-empty, covers the scenario IDs required by the artifact manifest, and
covers the scenario's required benchmark comparisons from `/api/dsp/benchmark-plan`:

```json
{
  "schemaVersion": 1,
  "artifactId": "audio-render-before-after",
  "files": [
    {
      "path": "artifacts/audio/weak-cw-before.wav",
      "scenarioId": "weak-cw-carrier",
      "comparison": "off-baseline"
    },
    {
      "path": "artifacts/audio/weak-cw-thetis.wav",
      "scenarioId": "weak-cw-carrier",
      "comparison": "thetis-parity"
    },
    {
      "path": "artifacts/audio/weak-cw-current-zeus.wav",
      "scenarioId": "weak-cw-carrier",
      "comparison": "current-zeus"
    },
    {
      "path": "artifacts/audio/weak-cw-nr5.wav",
      "scenarioId": "weak-cw-carrier",
      "candidate": "nr5-spnr"
    }
  ]
}
```

The `offline-fixture-metrics` artifact is a metrics JSON file. For each required scenario and
comparison, strict validation checks that the metrics named by `/api/dsp/benchmark-plan` are present
and that at least one gate outcome is recorded. Metric names are normalized for punctuation/case, so
`wanted SNR`, `wantedSnr`, and `wanted-snr` all satisfy the same required metric:

```json
{
  "schemaVersion": 1,
  "scenarios": [
    {
      "scenarioId": "weak-cw-carrier",
      "comparisons": [
        {
          "comparison": "off-baseline",
          "metrics": {
            "coherentTonePower": -46.2,
            "wantedSnr": 8.5,
            "spectralPreservation": 1.0,
            "outputRms": 0.018,
            "latency": 0.0
          },
          "gates": [
            { "id": "weak-signal-preserved", "passed": true }
          ]
        }
      ]
    }
  ]
}
```

Run `tools/compare-dsp-fixture-metrics.ps1` after filling `offline-fixture-metrics.json`. It reads
the captured benchmark plan, metric catalog, and metrics artifact, compares every candidate against
`current-zeus` and `thetis-parity`, writes `dsp-fixture-metric-comparison.json` plus a Markdown
summary, and can fail a quality gate with `-FailOnRegression`. Metric directions come from
`benchmark-metric-catalog.json` when present; the script only falls back to built-in conservative
directions for older bundles. The strict bundle validator consumes the JSON report as generated
evidence; passing candidates still need G2 and cross-radio evidence before any default change is
considered.

The live readiness surface is `/api/dsp/live-diagnostics`. It is read-only and combines the current
Smart NR condition, WDSP native capability probes, frontend DSP scene freshness, RX-chain health,
and NR5/SPNR diagnostics into a tool-friendly readiness score, constraint list, recommended action,
and candidate tool list for G2 benchmark sessions. It is an evidence aggregator only; it does not
change DSP defaults or promote experimental behavior.

The live diagnostics response now includes `runtimeEvidence`, derived from the DSP pipeline's
existing diagnostic caches rather than new realtime work. It records RXA meter freshness, ADC
headroom, AGC gain, final RX/TX-monitor audio freshness, RMS/peak dBFS, squelch open/tail/gate
state, monitor backlog, audio sink count, and a runtime recommendation. Acceptance captures should
treat `final-audio-not-fresh`, `final-audio-clipping-risk`, and `adc-headroom-low` as blockers
before tuning AGC, NR5/SPNR, squelch, or post-demod external engines.

The optional external-engine catalog is `/api/dsp/external-engine-candidates`. It classifies every
non-WDSP candidate as a post-demod bakeoff target with explicit blockers:

| Candidate | Role | Initial risk | Required gate |
|---|---|---|---|
| RNNoise | Small C neural speech denoiser | Speech-trained model can damage CW/data/non-speech HF content | Package/model review, speech fixture win, weak-carrier bypass proof |
| DeepFilterNet | Modern full-band neural speech enhancement | Heavy Rust/Python/model packaging and latency risk | Model license/package review, artifact score win, G2 CPU/latency proof |
| SpeexDSP | Classic DSP baseline/utilities | AGC/noise processing can fight WDSP AGC | Feature-level gating, no pumping, meter/squelch stability |
| WebRTC Audio Processing | Communications audio NS/VAD reference | AEC/AGC/high-pass defaults can corrupt radio gain staging | NS/VAD-only spike, AGC/AEC disabled, no TX/PureSignal coupling |

## Modernization Policy

1. Stabilize parity first. Do not tune around an unknown Zeus/Thetis delta.
2. Keep all new DSP behavior opt-in until the measured result beats current Zeus behavior on the G2
   and survives on-air review.
3. Evaluate RNNoise, DeepFilterNet, SpeexDSP, and WebRTC Audio Processing only as optional post-demod
   speech/audio candidates unless a benchmark proves a lower-level integration is safe.
4. Preserve WDSP as the core DSP engine. External technology may augment receive/transmit audio, but
   it must have clean licensing, packageability, CPU/latency bounds, and fallback behavior.
5. No operator default changes without a separate approval backed by metrics and hardware evidence.

## Acceptance Matrix

| Gate | Required for Phase 1 | Required before completion |
|---|---:|---:|
| Lineage/parity document | yes | yes |
| Deterministic offline fixtures | yes | yes |
| Native WDSP build | targeted | all supported runtime targets |
| `dotnet build` / `dotnet test` | targeted | full solution |
| Frontend tests | no UI change in Phase 1 | required for UI/profile changes |
| G2 bench validation | design required | required |
| G2 hardware diagnostics bundle evidence | required | required |
| Cross-radio validation | planned | required |
| Operator defaults unchanged | required | required unless separately approved |

## Immediate Follow-ups

- Classify native WDSP file drift against Thetis with line-ending-insensitive diffs.
- Add a WDSP-backed benchmark runner that feeds the offline fixtures through `WdspDspEngine`.
- Promote focused NR5/SPNR fixtures from diagnostic tests into the shared benchmark catalog.
- Add TXA benchmark capture for leveler/CFC/compressor/ALC with PureSignal disabled and enabled.
- Record G2 bench results alongside fixture metrics before any opt-in profile graduates.
