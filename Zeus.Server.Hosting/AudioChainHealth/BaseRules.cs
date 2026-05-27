// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

using System.Globalization;
using Zeus.Contracts;

namespace Zeus.Server.AudioChainHealth;

/// <summary>
/// The v1 base rule set — Thetis-convention seed thresholds spanning
/// the nine factory-widget stages. Per ADR-0001 / CONTEXT.md, these
/// are red-light maintainer values: each threshold is a default an
/// operator will feel on first connect, sourced from Thetis SSB
/// convention rather than measured against a specific board. The
/// per-(mode, board) override layer (zeus-y89) shadows specific
/// numbers; HL2's drive ceiling and FM/CW/Digital applicability all
/// live there, not here.
///
/// <para>Applicability for v1: every rule below is gated to <b>SSB
/// modes with MOX engaged</b>. CW / FM / Digital disable the WDSP
/// chain entirely or invert the verdicts; the per-context overrides
/// will switch the appropriate rules off or replace them. Without
/// overrides, the operator in SSB sees the full chain critique while
/// the operator in CW sees PA-only verdicts (via overrides), per
/// CONTEXT.md.</para>
///
/// <para><b>Sentinel handling:</b> WDSP stages emit ≤ -200 dBFS when
/// idle (the -400 silence sentinel makes its way out as -∞). Each
/// rule's <c>Read</c> returns a "safely non-tripping" value when the
/// reading is a sentinel so a momentary bypass doesn't trip a level
/// rule or clear a fired one prematurely.</para>
/// </summary>
public static class BaseRules
{
    /// <summary>The whole base set in pipeline order. Each rule is
    /// MOX-gated to SSB modes (USB / LSB). Per-context overrides apply
    /// on top of this in zeus-y89.</summary>
    public static IReadOnlyList<AudioChainRule> All { get; } = new AudioChainRule[]
    {
        MicLow(),
        MicHot(),
        EqClipping(),
        LevelerRunaway(),
        CfcPumping(),
        CompPumping(),
        AlcClipping(),
        AlcExcessive(),
        OutClipping(),
        WireDriveCeiling(),
        PaSwrWarn(),
        PaSwrRunaway(),
        PaFwdWeak(),
    };

    // ---------------------------------------------------------------
    // Applicability predicates. The base rules apply in SSB
    // (USB / LSB) under MOX; everything else routes through per-
    // context overrides in zeus-y89 (CW disables WDSP rules, Digital
    // inverts processing rules, FM bypasses Lvlr/CFC/Comp, AM shifts
    // ALC headroom).
    // ---------------------------------------------------------------

    private static bool IsSsbMox(RuleContext c) =>
        c.Mox && (c.Mode == RxMode.USB || c.Mode == RxMode.LSB);

    // ---------------------------------------------------------------
    // Reading guards. Sentinel-safe accessors that fold an idle WDSP
    // stage into a "safely non-tripping" value so a transient bypass
    // doesn't drive a rule one way or the other.
    // ---------------------------------------------------------------

    /// <summary>For Below-direction rules: sentinel reads return a
    /// value comfortably above the rule's enter threshold so a
    /// bypassed stage can't trip a "too low" rule.</summary>
    private static float SafeForBelowRule(float dbfs) =>
        AudioChainReadings.IsSentinel(dbfs) ? 0f : dbfs;

    /// <summary>For Above-direction rules on dBFS: sentinel reads
    /// return a value comfortably below the rule's enter threshold.</summary>
    private static float SafeForAboveRule(float dbfs) =>
        AudioChainReadings.IsSentinel(dbfs) ? -100f : dbfs;

    /// <summary>For GR (gain reduction) rules: sentinel is 0 by
    /// convention (idle stage = no cut).</summary>
    private static float SafeGr(float gr) =>
        !float.IsFinite(gr) ? 0f : gr;

    // ---------------------------------------------------------------
    // Stage 01 — Mic
    // ---------------------------------------------------------------

    private static AudioChainRule MicLow() => new()
    {
        Name = "mic.low",
        Stage = AudioChainStageId.Mic,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = IsSsbMox,
        Read = r => SafeForBelowRule(r.MicAv),
        // Thetis SSB convention: −24 dBFS average is the canonical
        // healthy mic target. Trip below −40 dBFS sustained — way
        // below the sweet spot, the leveler will be working overtime.
        // Clear above −36 dBFS (4 dB hysteresis band).
        EnterThreshold = -40,
        ExitThreshold = -36,
        Direction = TripDirection.Below,
        Message = (r, _) => FormattableString.Invariant(
            $"Mic too low — average {r.MicAv:F0} dBFS. Raise mic gain to land near −24 dBFS."),
        ApplyLabel = (_, _) => "Apply · target −24 dBFS",
        // Target value is the desired average, not the gain delta.
        // The dispatcher (zeus-pgn) translates this into the right
        // mic-gain change based on the current mic level.
        Apply = (_, _) => new AudioChainApplyAction("tx.mic-av-target-dbfs", -24),
    };

    private static AudioChainRule MicHot() => new()
    {
        Name = "mic.hot",
        Stage = AudioChainStageId.Mic,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = IsSsbMox,
        Read = r => SafeForAboveRule(r.MicPk),
        // Mic peak hot when peaks crowd 0 dBFS. Healthy SSB mic peak
        // is −10 to −6 dBFS. Trip above −3 dBFS, clear under −6.
        EnterThreshold = -3,
        ExitThreshold = -6,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"Mic too hot — peaks at {r.MicPk:F0} dBFS. Back off mic gain."),
        ApplyLabel = (_, _) => "Apply · target −24 dBFS",
        Apply = (_, _) => new AudioChainApplyAction("tx.mic-av-target-dbfs", -24),
    };

    // ---------------------------------------------------------------
    // Stage 02 — EQ
    // ---------------------------------------------------------------

    private static AudioChainRule EqClipping() => new()
    {
        Name = "eq.clip",
        Stage = AudioChainStageId.Eq,
        Severity = AudioChainSeverity.Error,
        AppliesIn = IsSsbMox,
        Read = r => SafeForAboveRule(r.EqPk),
        // EQ output should never clip; a boosted band at the EQ stage
        // crossing 0 dBFS distorts before everything downstream sees
        // the signal. Tight hysteresis — 1 dB.
        EnterThreshold = 0,
        ExitThreshold = -1,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"EQ clipping — peak at {r.EqPk:F1} dBFS. Lower the boosted band(s) or pre-EQ level."),
    };

    // ---------------------------------------------------------------
    // Stage 03 — Leveler
    // ---------------------------------------------------------------

    private static AudioChainRule LevelerRunaway() => new()
    {
        Name = "leveler.runaway",
        Stage = AudioChainStageId.Leveler,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = IsSsbMox,
        Read = r => SafeGr(r.LvlrGr),
        // Leveler GR of a few dB is healthy. Sustained > 12 dB GR
        // means the leveler is doing the leveler-AND-the-mic-gain's
        // job — root cause is usually a too-low mic. Clear under 10.
        EnterThreshold = 12,
        ExitThreshold = 10,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"Leveler working overtime — gain reduction {r.LvlrGr:F0} dB. Mic gain likely too low."),
    };

    // ---------------------------------------------------------------
    // Stage 04 — CFC (Continuous Frequency Compressor)
    // ---------------------------------------------------------------

    private static AudioChainRule CfcPumping() => new()
    {
        Name = "cfc.pumping",
        Stage = AudioChainStageId.Cfc,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = IsSsbMox,
        Read = r => SafeGr(r.CfcGr),
        // CFC GR > 10 dB on peaks is audible pumping. Lower CFC drive
        // by ~3 dB is the canonical remedy; the dispatcher computes
        // the absolute target from the current value.
        EnterThreshold = 10,
        ExitThreshold = 8,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"CFC pumping — gain reduction {r.CfcGr:F0} dB. Lower CFC drive ~3 dB."),
        ApplyLabel = (_, _) => "Apply · CFC drive −3 dB",
        Apply = (_, _) => new AudioChainApplyAction("tx.cfc-drive-delta-db", -3),
    };

    // ---------------------------------------------------------------
    // Stage 05 — Compressor
    // ---------------------------------------------------------------

    private static AudioChainRule CompPumping() => new()
    {
        Name = "comp.pumping",
        Stage = AudioChainStageId.Comp,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = IsSsbMox,
        // We don't have a direct Comp-GR field from WDSP — peak is the
        // proxy. Comp output peaking near 0 dBFS means the compressor
        // is saturating into the ALC; back off drive.
        Read = r => SafeForAboveRule(r.CompPk),
        EnterThreshold = -2,
        ExitThreshold = -4,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"Compressor saturating — peak {r.CompPk:F0} dBFS. Back off drive or compressor threshold."),
    };

    // ---------------------------------------------------------------
    // Stage 06 — ALC (Automatic Level Control — the last line of
    // defence before the IQ modulator)
    // ---------------------------------------------------------------

    private static AudioChainRule AlcClipping() => new()
    {
        Name = "alc.clip",
        Stage = AudioChainStageId.Alc,
        Severity = AudioChainSeverity.Error,
        ImmediateAction = true,
        AppliesIn = IsSsbMox,
        Read = r => SafeForAboveRule(r.AlcPk),
        // ALC peak above 0 dBFS = clipping into the modulator =
        // splatter on-air. Immediate-action: the operator's signal is
        // distorted right now. Tight hysteresis; this is a hard limit.
        EnterThreshold = 0,
        ExitThreshold = -1,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"Clipping — ALC peak {r.AlcPk:F1} dBFS. Distorted on-air. Lower drive immediately."),
        ApplyLabel = (_, _) => "Apply · drive −15",
        Apply = (r, _) => new AudioChainApplyAction(
            "tx.drive-pct-target",
            Math.Max(1, r.DrivePct - 15)),
        // ALC clip is severe enough that the default 5 s error window
        // is too slow — fire after 1.5 s so the operator sees it
        // within two transmit syllables, not after the QSO turn.
        SustainedWindow = TimeSpan.FromMilliseconds(1500),
    };

    private static AudioChainRule AlcExcessive() => new()
    {
        Name = "alc.excessive",
        Stage = AudioChainStageId.Alc,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = IsSsbMox,
        Read = r => SafeGr(r.AlcGr),
        // ALC should rarely engage in normal SSB operation — sustained
        // GR > 6 dB means the compressor or drive is set too aggressively.
        EnterThreshold = 6,
        ExitThreshold = 4,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"ALC working hard — gain reduction {r.AlcGr:F0} dB. Lower drive or compression."),
    };

    // ---------------------------------------------------------------
    // Stage 07 — Out (TXA output, post-ALC, just before the IQ modulator)
    // ---------------------------------------------------------------

    private static AudioChainRule OutClipping() => new()
    {
        Name = "out.clip",
        Stage = AudioChainStageId.Out,
        Severity = AudioChainSeverity.Error,
        AppliesIn = IsSsbMox,
        Read = r => SafeForAboveRule(r.OutPk),
        EnterThreshold = 0,
        ExitThreshold = -1,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"TXA output clipping — peak {r.OutPk:F1} dBFS. Lower drive."),
    };

    // ---------------------------------------------------------------
    // Stage 08 — Wire (drive / IQ / packet rate)
    // ---------------------------------------------------------------

    private static AudioChainRule WireDriveCeiling() => new()
    {
        Name = "wire.drive.ceiling",
        Stage = AudioChainStageId.Wire,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = c => c.Mox, // wire reading is meaningful in any TX mode
        Read = r => r.DrivePct,
        // Drive pegged at 100% means the operator has asked for more
        // output than the PA / board profile can deliver. On HL2
        // specifically this hits the 4-bit drive register ceiling well
        // below where dB-based boards run out of headroom; the per-
        // context override (zeus-y89) will tighten this for HL2.
        EnterThreshold = 99,
        ExitThreshold = 95,
        Direction = TripDirection.Above,
        Message = (r, _) => FormattableString.Invariant(
            $"Drive at ceiling ({r.DrivePct}%) — output won't go higher."),
    };

    // ---------------------------------------------------------------
    // Stage 09 — PA (forward / reflected / SWR / V / A)
    // ---------------------------------------------------------------

    private static AudioChainRule PaSwrWarn() => new()
    {
        Name = "pa.swr.warn",
        Stage = AudioChainStageId.Pa,
        Severity = AudioChainSeverity.Warn,
        AppliesIn = c => c.Mox,
        Read = r => r.Swr,
        // SWR > 2.0 is operator-meaningful: antenna match degrading or
        // wrong band. Below 1.8 we treat as clean. Existing
        // TxMetersService SWR trip handles the 2.5+ protection cut-off
        // at the radio; this is just operator visibility.
        EnterThreshold = 2.0,
        ExitThreshold = 1.8,
        Direction = TripDirection.Above,
        Message = (r, _) => string.Format(
            CultureInfo.InvariantCulture,
            "SWR {0:F1}:1 — antenna match degraded.",
            r.Swr),
    };

    private static AudioChainRule PaSwrRunaway() => new()
    {
        Name = "pa.swr.runaway",
        Stage = AudioChainStageId.Pa,
        Severity = AudioChainSeverity.Error,
        ImmediateAction = true,
        AppliesIn = c => c.Mox,
        Read = r => r.Swr,
        // SWR > 3:1 is unkey-now territory — finals overheat, fault
        // protection trips. Tight 1.5 s sustained gate so the operator
        // sees this before the existing SWR trip kicks in at 2.5
        // sustained 500 ms; this fires first as guidance.
        EnterThreshold = 3.0,
        ExitThreshold = 2.5,
        Direction = TripDirection.Above,
        Message = (r, _) => string.Format(
            CultureInfo.InvariantCulture,
            "STOP TX — SWR {0:F1}:1, reflected {1:F0}W. Antenna fault or wrong band. Unkey now.",
            r.Swr,
            r.RefWatts),
        SustainedWindow = TimeSpan.FromMilliseconds(1500),
    };

    private static AudioChainRule PaFwdWeak() => new()
    {
        Name = "pa.fwd.weak",
        Stage = AudioChainStageId.Pa,
        Severity = AudioChainSeverity.Warn,
        // Only fire when the operator is asking for real power (drive >
        // 20%). Below that the radio may legitimately be loafing at low
        // drive into a clean load, and "weak FWD" is not a complaint.
        AppliesIn = c => c.Mox,
        Read = r =>
        {
            // Suppress this rule when drive is low — we can't say the
            // PA is weak if the operator isn't asking for much.
            if (r.DrivePct < 20) return 999f; // safely above any "Below" threshold
            return r.FwdWatts;
        },
        EnterThreshold = 2,
        ExitThreshold = 5,
        Direction = TripDirection.Below,
        Message = (r, _) => FormattableString.Invariant(
            $"Forward power low — {r.FwdWatts:F0}W at {r.DrivePct}% drive. Possible PA fault, bad RF chain, or band-disabled output."),
    };
}

/// <summary>
/// Wires the <see cref="BaseRules"/> static list into DI. Per-context
/// overrides (zeus-y89) will layer over this provider.
/// </summary>
public sealed class BaseAudioChainRuleProvider : IAudioChainRuleProvider
{
    public IReadOnlyList<AudioChainRule> Rules => BaseRules.All;
}
