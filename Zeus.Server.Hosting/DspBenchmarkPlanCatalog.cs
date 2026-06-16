// SPDX-License-Identifier: GPL-2.0-or-later
//
// Read-only benchmark and acceptance plan for WDSP modernization. This is a
// planning/diagnostic surface only; it does not run DSP or change defaults.

using Zeus.Contracts;

namespace Zeus.Server;

public static class DspBenchmarkPlanCatalog
{
    private const string RolloutGate = "no-default-change-without-offline-benchmark-g2-on-air-and-cross-radio-evidence";

    public static DspBenchmarkPlanDto Build() =>
        new(
            SchemaVersion: 1,
            GeneratedUtc: DateTimeOffset.UtcNow,
            Status: "ready-for-capture-planning",
            RolloutGate: RolloutGate,
            FirstHardwareTarget: "G2",
            RequiredHardwareBeforeGraduation:
            [
                "G2 receive and transmit validation",
                "At least one non-G2 OpenHPSDR-compatible radio validation",
                "On-air receive review across weak CW/carrier and SSB speech",
                "TX monitor and PureSignal-safe bypass review before TX profile graduation",
            ],
            RequiredComparisons:
            [
                "off-baseline",
                "thetis-parity",
                "current-zeus",
                "nr5-spnr",
                "candidate-external-engine-opt-in",
            ],
            GlobalAcceptanceGates:
            [
                "Beat current Zeus behavior on targeted metric without breaking Thetis parity.",
                "No audible AGC or NR pumping on level-step and fading fixtures.",
                "No weak-signal loss on coherent weak carrier/CW fixtures.",
                "No TX clipping, ALC instability, or PureSignal coupling regression.",
                "No native WDSP lifecycle instability or channel-state leakage.",
                "All experimental behavior remains opt-in until benchmark and hardware evidence is reviewed.",
            ],
            Scenarios: AllScenarios());

    public static DspBenchmarkMetricCatalogDto BuildMetricCatalog()
    {
        var scenarios = AllScenarios();
        return new DspBenchmarkMetricCatalogDto(
            SchemaVersion: 1,
            GeneratedUtc: DateTimeOffset.UtcNow,
            Status: "ready-for-offline-comparison-tooling",
            RolloutPolicy: "metric-semantics-only-no-runtime-dsp-behavior-change",
            DirectionValues: ["higher", "lower", "informational"],
            Metrics: AllMetrics(scenarios));
    }

    public static string[] NextScenarioIds(SmartNrConditionDto condition)
    {
        ArgumentNullException.ThrowIfNull(condition);

        var scenarios = new List<string>();

        if (!condition.Available || !condition.Fresh)
        {
            scenarios.Add("frontend-scene-freshness");
            scenarios.Add("noise-only-gating");
        }

        if (ModeEquals(condition.ExpectedNrMode, "Nr5") || ModeEquals(condition.EffectiveNrMode, "Nr5"))
        {
            scenarios.Add("weak-cw-carrier");
            scenarios.Add("fading-carrier");
            scenarios.Add("strong-adjacent");
            scenarios.Add("agc-level-step");
        }
        else if (ModeEquals(condition.ExpectedNrMode, "Emnr") || ModeEquals(condition.EffectiveNrMode, "Emnr")
            || ModeEquals(condition.ExpectedNrMode, "Sbnr") || ModeEquals(condition.EffectiveNrMode, "Sbnr"))
        {
            scenarios.Add("ssb-like-speech");
            scenarios.Add("weak-cw-carrier");
            scenarios.Add("noise-only-gating");
        }

        if (condition.HeldByRxChain == true || string.Equals(condition.RxChainTone, "protect", StringComparison.OrdinalIgnoreCase))
        {
            scenarios.Add("agc-level-step");
            scenarios.Add("squelch-transition");
        }

        if (condition.Nr5SpnrDiagnostics is { SignalConfidence: < 0.20 }
            || condition.CoherentSubthresholdSignal == true)
            scenarios.Add("weak-cw-carrier");

        if (scenarios.Count == 0)
        {
            scenarios.Add("weak-cw-carrier");
            scenarios.Add("ssb-like-speech");
            scenarios.Add("tx-puresignal-safe-bypass");
        }

        return scenarios.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static DspBenchmarkScenarioDto[] AllScenarios() =>
    [
        Scenario(
            id: "frontend-scene-freshness",
            name: "Frontend scene freshness and clock alignment",
            phase: "live-diagnostics",
            signalPath: "frontend-spectrum-scene",
            fixtureStatus: "live-capture-required",
            appliesTo: ["Smart NR", "live diagnostics", "G2"],
            metrics: ["scene age", "source clock skew", "scene freshness", "runtime alignment"],
            gates:
            [
                "Scene age must be fresh enough for live decisions.",
                "Source clock skew must stay inside the live diagnostics limit.",
                "Requested/effective NR mode must be aligned or explicitly apply-pending.",
            ],
            artifacts: ["live diagnostics JSON", "frontend DSP scene snapshot"]),
        Scenario(
            id: "weak-cw-carrier",
            name: "Weak CW/carrier preservation",
            phase: "offline-and-g2-live",
            signalPath: "RX IQ",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["NR2", "NR4", "NR5/SPNR", "external speech bypass"],
            metrics: ["coherent tone power", "wanted SNR", "spectral preservation", "output RMS", "latency"],
            gates:
            [
                "Wanted coherent tone must not disappear below off/current Zeus baseline.",
                "NR gain must stay bounded with no audible breathing around the signal.",
                "External post-demod engines must bypass or prove neutral behavior.",
            ],
            artifacts: ["fixture metrics JSON", "audio render", "spectrum before/after"]),
        Scenario(
            id: "ssb-like-speech",
            name: "SSB-like speech readability",
            phase: "offline-and-g2-live",
            signalPath: "RX audio",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["NR2", "NR4", "NR5/SPNR", "RNNoise", "DeepFilterNet", "SpeexDSP", "WebRTC APM"],
            metrics: ["speech-band preservation", "noise reduction", "artifact score", "RMS movement", "CPU", "latency"],
            gates:
            [
                "Speech readability must improve over current Zeus without metallic artifacts.",
                "No double-AGC pumping or level collapse.",
                "Candidate engines must remain post-demod and opt-in.",
            ],
            artifacts: ["fixture metrics JSON", "speech audio render", "artifact notes"]),
        Scenario(
            id: "fading-carrier",
            name: "Fading carrier stability",
            phase: "offline-and-g2-live",
            signalPath: "RX IQ",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["AGC", "NR2", "NR5/SPNR"],
            metrics: ["windowed RMS movement", "coherent tone continuity", "AGC gain movement", "latency"],
            gates:
            [
                "Fading signal must remain audible without NR gate chatter.",
                "AGC must not chase the noise floor into pumping.",
            ],
            artifacts: ["fixture metrics JSON", "AGC movement trace"]),
        Scenario(
            id: "impulse-noise",
            name: "Impulse noise and blanker interaction",
            phase: "offline-and-g2-live",
            signalPath: "RX IQ",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["NB1", "NB2", "SNB", "NR5/SPNR"],
            metrics: ["impulse suppression", "wanted SNR", "post-blanker ringing", "artifact score"],
            gates:
            [
                "Impulse suppression must not smear or mute wanted signal content.",
                "NB/NR combinations must not crash or leave WDSP state inconsistent.",
            ],
            artifacts: ["fixture metrics JSON", "before/after waveform"]),
        Scenario(
            id: "strong-adjacent",
            name: "Strong adjacent signal rejection",
            phase: "offline-and-g2-live",
            signalPath: "RX IQ",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["filters", "AGC", "NR2", "NR4", "NR5/SPNR"],
            metrics: ["wanted/adjacent ratio", "filter leakage", "AGC movement", "spectral preservation"],
            gates:
            [
                "Adjacent energy must not drive AGC/NR into wanted signal loss.",
                "Filter parity with Thetis must remain intact.",
            ],
            artifacts: ["fixture metrics JSON", "spectrum before/after"]),
        Scenario(
            id: "noise-only-gating",
            name: "Noise-only gating and false-signal avoidance",
            phase: "offline-and-g2-live",
            signalPath: "RX IQ/RX audio",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["squelch", "Smart NR", "external speech engines"],
            metrics: ["false-open rate", "noise floor movement", "artifact score", "CPU"],
            gates:
            [
                "No false coherent-signal detection on noise-only scenes.",
                "External engines must not create speech-like artifacts that fool meters or Smart NR.",
            ],
            artifacts: ["fixture metrics JSON", "meter trace"]),
        Scenario(
            id: "agc-level-step",
            name: "AGC level step and pumping",
            phase: "offline-and-g2-live",
            signalPath: "RX IQ/RX audio",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["WDSP AGC", "Auto AGC", "NR5/SPNR AGC", "external post-demod engines"],
            metrics: ["AGC gain movement", "windowed RMS movement", "settling time", "overshoot", "artifact score"],
            gates:
            [
                "No audible pumping, clipping, or noise-floor chase.",
                "Bounded gain movement must preserve weak-signal audibility.",
            ],
            artifacts: ["fixture metrics JSON", "AGC trace", "audio render"]),
        Scenario(
            id: "squelch-transition",
            name: "Squelch open/close transition",
            phase: "offline-and-g2-live",
            signalPath: "RX audio",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["SSQL", "AMSQ", "FMSQ", "adaptive squelch", "external post-demod engines"],
            metrics: ["open latency", "close latency", "false-open rate", "audio discontinuity"],
            gates:
            [
                "Squelch must not chatter or open on external-engine artifacts.",
                "Open/close transitions must not leave stale audio or meters.",
            ],
            artifacts: ["fixture metrics JSON", "squelch trace"]),
        Scenario(
            id: "tx-two-tone",
            name: "TX two-tone linearity and limiter safety",
            phase: "offline-and-g2-bench",
            signalPath: "TX audio/TXA",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["TX leveler", "CFC", "compressor", "ALC"],
            metrics: ["peak", "crest factor", "clipping count", "intermodulation proxy", "latency"],
            gates:
            [
                "No TX clipping or uncontrolled ALC action.",
                "Thetis-compatible TXA behavior must remain the reference unless explicitly approved.",
            ],
            artifacts: ["fixture metrics JSON", "TX audio render"]),
        Scenario(
            id: "tx-voice-like",
            name: "TX voice-like audio shaping",
            phase: "offline-and-g2-bench",
            signalPath: "TX audio/TXA",
            fixtureStatus: "offline-fixture-ready",
            appliesTo: ["TX leveler", "CFC", "compressor", "ALC", "future external speech tools"],
            metrics: ["RMS", "peak", "crest factor", "spectral balance", "latency"],
            gates:
            [
                "Voice-like TX audio must not clip, pump, or overdrive downstream TX stages.",
                "External enhancement candidates must not touch TX by default.",
            ],
            artifacts: ["fixture metrics JSON", "TX audio render"]),
        Scenario(
            id: "tx-puresignal-safe-bypass",
            name: "PureSignal-safe bypass and TX monitor isolation",
            phase: "g2-bench-required",
            signalPath: "TX feedback/PureSignal",
            fixtureStatus: "hardware-capture-required",
            appliesTo: ["PureSignal", "CFIR", "TX monitor", "external speech tools"],
            metrics: ["bypass state", "feedback stability", "TX monitor coupling", "clipping count"],
            gates:
            [
                "No modernization path may change PureSignal default or bypass state.",
                "TX monitor/external candidates must not couple into feedback correction.",
                "PureSignal disabled and enabled paths must both be captured before TX graduation.",
            ],
            artifacts: ["G2 bench capture", "TX feedback trace", "diagnostics JSON"]),
        Scenario(
            id: "wdsp-channel-lifecycle",
            name: "WDSP channel lifecycle and state transitions",
            phase: "automated-and-g2-live",
            signalPath: "RXA/TXA lifecycle",
            fixtureStatus: "lifecycle-test-required",
            appliesTo: ["OpenChannel", "SetChannelState", "MOX", "RXA", "TXA"],
            metrics: ["state transition success", "meter escape", "audio drain", "native exception count"],
            gates:
            [
                "Open/stop/configure/start transitions must stay stable under RX/TX changes.",
                "No stale meters or audio buffers may leak across channel state changes.",
            ],
            artifacts: ["lifecycle test log", "diagnostics JSON"])];

    private static DspBenchmarkScenarioDto Scenario(
        string id,
        string name,
        string phase,
        string signalPath,
        string fixtureStatus,
        string[] appliesTo,
        string[] metrics,
        string[] gates,
        string[] artifacts) =>
        new(
            SchemaVersion: 1,
            Id: id,
            Name: name,
            Phase: phase,
            SignalPath: signalPath,
            FixtureStatus: fixtureStatus,
            AppliesTo: appliesTo,
            RequiredComparisons:
            [
                "off-baseline",
                "thetis-parity",
                "current-zeus",
                "candidate-under-test",
            ],
            RequiredMetrics: metrics,
            AcceptanceGates: gates,
            RequiredArtifacts: artifacts,
            FailureModes:
            [
                "weak-signal-loss",
                "audible-pumping",
                "artifact-regression",
                "meter-drift",
                "native-lifecycle-instability",
            ],
            RelatedTools:
            [
                "offline-dsp-benchmark-harness",
                "g2-live-capture",
                "dsp-live-diagnostics",
            ]);

    private static DspBenchmarkMetricDto[] AllMetrics(DspBenchmarkScenarioDto[] scenarios) =>
    [
        Metric(scenarios, "scene age", "lower", "ms", "diagnostic-freshness",
            "Older frontend scene data weakens live DSP recommendations and should trend down."),
        Metric(scenarios, "source clock skew", "lower", "ms", "diagnostic-freshness",
            "Clock skew between producers and diagnostics should stay bounded for live decisions."),
        Metric(scenarios, "scene freshness", "higher", "score", "diagnostic-freshness",
            "Fresh, current scene evidence is required before tuning Smart NR or external engines."),
        Metric(scenarios, "runtime alignment", "higher", "score", "diagnostic-freshness",
            "Requested and effective DSP runtime state should agree before capture."),

        Metric(scenarios, "coherent tone power", "higher", "dB", "weak-signal-preservation",
            "Weak coherent carriers must not be attenuated below current Zeus or Thetis parity."),
        Metric(scenarios, "wanted SNR", "higher", "dB", "weak-signal-preservation",
            "Wanted signal-to-noise ratio is a direct preservation/improvement metric."),
        Metric(scenarios, "spectral preservation", "higher", "score", "weak-signal-preservation",
            "Preserve wanted spectral shape while reducing unwanted noise or adjacent energy."),
        Metric(scenarios, "output RMS", "informational", "linear-or-dBFS", "level-context",
            "Output level is context for AGC/audio review; direction depends on scenario and gain policy."),

        Metric(scenarios, "speech-band preservation", "higher", "score", "speech-preservation",
            "Speech enhancement must preserve intelligibility-bearing spectrum."),
        Metric(scenarios, "noise reduction", "higher", "dB", "noise-reduction",
            "Reduction of unwanted noise is useful only when preservation gates also pass."),
        Metric(scenarios, "artifact score", "lower", "score", "artifact-control",
            "Lower artifact scoring means fewer metallic, speech-like, pumping, or ringing artifacts."),
        Metric(scenarios, "RMS movement", "lower", "dB-or-score", "pumping-control",
            "Level movement should be bounded to prevent audible pumping."),
        Metric(scenarios, "CPU", "lower", "percent-or-ms", "runtime-cost",
            "Lower processing cost leaves more margin for high-rate G2 workloads."),
        Metric(scenarios, "latency", "lower", "ms", "runtime-cost",
            "Lower latency is preferred when preservation and artifact gates still pass."),

        Metric(scenarios, "windowed RMS movement", "lower", "dB-or-score", "pumping-control",
            "Short-window level movement catches AGC/NR breathing and pumping."),
        Metric(scenarios, "coherent tone continuity", "higher", "score", "weak-signal-preservation",
            "Fading weak signals should remain continuous instead of being gated away."),
        Metric(scenarios, "AGC gain movement", "lower", "dB-or-score", "pumping-control",
            "AGC should normalize perceived level without excessive gain hunting."),

        Metric(scenarios, "impulse suppression", "higher", "dB-or-score", "noise-reduction",
            "Impulse suppression should improve while preserving wanted content."),
        Metric(scenarios, "post-blanker ringing", "lower", "score", "artifact-control",
            "Blanker/NR combinations should not leave ringing after impulses."),
        Metric(scenarios, "wanted/adjacent ratio", "higher", "dB", "selectivity",
            "Wanted energy should improve relative to strong adjacent signals."),
        Metric(scenarios, "filter leakage", "lower", "dB-or-score", "selectivity",
            "Lower leakage indicates better selectivity without harming Thetis parity."),
        Metric(scenarios, "AGC movement", "lower", "dB-or-score", "pumping-control",
            "AGC movement should stay bounded when adjacent energy changes."),

        Metric(scenarios, "false-open rate", "lower", "rate", "gate-stability",
            "Noise-only or artifact-heavy inputs must not falsely open squelch/meters."),
        Metric(scenarios, "noise floor movement", "lower", "dB-or-score", "pumping-control",
            "Noise floor motion indicates AGC/NR chasing rather than stable leveling."),
        Metric(scenarios, "settling time", "lower", "ms", "pumping-control",
            "Shorter settling is preferred when it does not cause overshoot or weak-signal loss."),
        Metric(scenarios, "overshoot", "lower", "dB-or-score", "pumping-control",
            "Overshoot catches AGC/leveler instability after signal transitions."),

        Metric(scenarios, "open latency", "lower", "ms", "gate-stability",
            "Squelch should open promptly without chatter or false opens."),
        Metric(scenarios, "close latency", "lower", "ms", "gate-stability",
            "Squelch should close promptly without stale audio."),
        Metric(scenarios, "audio discontinuity", "lower", "score", "artifact-control",
            "Lower discontinuity means smoother gate transitions."),

        Metric(scenarios, "peak", "informational", "dBFS-or-linear", "tx-level-context",
            "Peak level is contextual; clipping and ALC behavior determine pass/fail direction."),
        Metric(scenarios, "crest factor", "informational", "dB", "tx-level-context",
            "Crest factor is mode/profile dependent and should be reviewed with clipping metrics."),
        Metric(scenarios, "clipping count", "lower", "count", "tx-safety",
            "TX and monitor paths must not clip while evaluating improvements."),
        Metric(scenarios, "intermodulation proxy", "lower", "score", "tx-linearity",
            "Lower intermodulation proxy indicates safer two-tone linearity."),
        Metric(scenarios, "RMS", "informational", "dBFS-or-linear", "level-context",
            "RMS level is context for loudness and TX drive review."),
        Metric(scenarios, "spectral balance", "informational", "score", "tx-audio-context",
            "Desired spectral balance depends on TX profile and voice target."),

        Metric(scenarios, "bypass state", "informational", "state", "puresignal-safety",
            "PureSignal bypass state is a safety invariant, not a numeric improvement target."),
        Metric(scenarios, "feedback stability", "higher", "score", "puresignal-safety",
            "Stable feedback is required before any TX/PureSignal-adjacent change graduates."),
        Metric(scenarios, "TX monitor coupling", "lower", "score", "puresignal-safety",
            "External or monitor audio must not couple into feedback correction."),
        Metric(scenarios, "state transition success", "higher", "score", "native-lifecycle",
            "WDSP channel lifecycle operations should complete cleanly."),
        Metric(scenarios, "meter escape", "lower", "count", "native-lifecycle",
            "Meters must not leak stale state across channel transitions."),
        Metric(scenarios, "audio drain", "lower", "samples-or-ms", "native-lifecycle",
            "Residual audio should drain promptly across state changes."),
        Metric(scenarios, "native exception count", "lower", "count", "native-lifecycle",
            "Native lifecycle work must not introduce WDSP exceptions."),
    ];

    private static DspBenchmarkMetricDto Metric(
        DspBenchmarkScenarioDto[] scenarios,
        string name,
        string direction,
        string unit,
        string safetyClass,
        string rationale)
    {
        var id = NormalizeMetricId(name);
        var related = scenarios
            .Where(s => s.RequiredMetrics.Any(m => NormalizeMetricId(m) == id))
            .Select(s => s.Id)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        return new DspBenchmarkMetricDto(
            SchemaVersion: 1,
            Id: id,
            Name: name,
            Direction: direction,
            Unit: unit,
            SafetyClass: safetyClass,
            Rationale: rationale,
            RelatedScenarios: related);
    }

    private static string NormalizeMetricId(string value) =>
        new(value
            .Trim()
            .ToLowerInvariant()
            .Where(char.IsLetterOrDigit)
            .ToArray());

    private static bool ModeEquals(string? left, string right) =>
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}
