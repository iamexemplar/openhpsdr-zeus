// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

using Zeus.Contracts;
using Zeus.Server.AudioChainHealth;
using Xunit;

namespace Zeus.Server.Tests.AudioChainHealth;

public class BaseRulesTests
{
    private static readonly DateTime T0 = new(2026, 5, 27, 12, 0, 0, DateTimeKind.Utc);

    private static AudioChainReadings AllOkUsb => new(
        MicPk: -12, MicAv: -24,
        EqPk: -10, EqAv: -22,
        LvlrPk: -10, LvlrAv: -20, LvlrGr: 3,
        CfcPk: -10, CfcAv: -18, CfcGr: 2,
        CompPk: -10, CompAv: -14,
        AlcPk: -6, AlcAv: -6, AlcGr: 1,
        OutPk: -3, OutAv: -3,
        DrivePct: 60, DriveByte: 0,
        FwdWatts: 80, RefWatts: 2, Swr: 1.2f);

    private static RuleContext SsbCtxMox => new(RxMode.USB, HpsdrBoardKind.HermesLite2, Mox: true);
    private static RuleContext SsbCtxRx => new(RxMode.USB, HpsdrBoardKind.HermesLite2, Mox: false);
    private static RuleContext CwCtxMox => new(RxMode.CWU, HpsdrBoardKind.HermesLite2, Mox: true);

    [Fact]
    public void AllOkReadings_FireNoRules()
    {
        var ev = new RuleEvaluator();
        // Tick well past every sustained window so a rule that wanted
        // to fire would have done so.
        for (int t = 0; t <= 10; t++)
        {
            var fired = ev.Evaluate(BaseRules.All, AllOkUsb, SsbCtxMox, T0.AddSeconds(t));
            Assert.Empty(fired);
        }
    }

    [Fact]
    public void RxOnly_FiresNothing_NoneOfTheTxRulesApply()
    {
        var ev = new RuleEvaluator();
        // Drive a reading that would trip multiple rules during MOX,
        // but without MOX every TX rule's AppliesIn should return false.
        var bad = AllOkUsb with
        {
            MicAv = -60,
            AlcPk = 2,
            Swr = 5f,
        };
        for (int t = 0; t <= 10; t++)
        {
            var fired = ev.Evaluate(BaseRules.All, bad, SsbCtxRx, T0.AddSeconds(t));
            Assert.Empty(fired);
        }
    }

    [Fact]
    public void CwMode_BaseRulesDoNotFire_ExceptPaRules()
    {
        var ev = new RuleEvaluator();
        // SWR runaway during CW — only the PA-side rules apply (Mox
        // gate only, no SSB gate). WDSP rules stay quiet because
        // they're SSB-gated; per-context overrides (zeus-y89) will
        // explicitly turn them into Info when CW is the canonical
        // context.
        var bad = AllOkUsb with { Swr = 4.0f, RefWatts = 30 };
        // Past the 1.5 s window for swr.runaway.
        for (int t = 0; t <= 2; t++)
        {
            _ = ev.Evaluate(BaseRules.All, bad, CwCtxMox, T0.AddSeconds(t));
        }
        // After 3 s sustained, both PA SWR rules fire. WDSP-stage
        // rules with the IsSsbMox gate do NOT (CW disables them).
        var fired = ev.Evaluate(BaseRules.All, bad, CwCtxMox, T0.AddSeconds(3.1));
        Assert.All(fired, f => Assert.Equal(AudioChainStageId.Pa, f.Rule.Stage));
        Assert.Contains(fired, f => f.Rule.Name == "pa.swr.runaway");
        Assert.Contains(fired, f => f.Rule.Name == "pa.swr.warn");
    }

    [Fact]
    public void MicLow_FiresAtMicAvBelowMinus40()
    {
        var ev = new RuleEvaluator();
        var low = AllOkUsb with { MicAv = -45, MicPk = -33 };
        // Past the default 3 s warn window.
        _ = ev.Evaluate(BaseRules.All, low, SsbCtxMox, T0);
        var fired = ev.Evaluate(BaseRules.All, low, SsbCtxMox, T0.AddSeconds(3.1));
        Assert.Contains(fired, f => f.Rule.Name == "mic.low");
        var mic = fired.First(f => f.Rule.Name == "mic.low");
        Assert.Equal(AudioChainSeverity.Warn, mic.Rule.Severity);
        Assert.NotNull(mic.Apply);
        Assert.Equal("tx.mic-av-target-dbfs", mic.Apply!.Value.Kind);
    }

    [Fact]
    public void AlcClip_FiresWithin1Point5Seconds_ImmediateAction()
    {
        var ev = new RuleEvaluator();
        // ALC peak at +1 dBFS = clipping.
        var clip = AllOkUsb with { AlcPk = 1 };
        _ = ev.Evaluate(BaseRules.All, clip, SsbCtxMox, T0);
        _ = ev.Evaluate(BaseRules.All, clip, SsbCtxMox, T0.AddSeconds(1));
        var fired = ev.Evaluate(BaseRules.All, clip, SsbCtxMox, T0.AddSeconds(1.5));
        var alc = fired.FirstOrDefault(f => f.Rule.Name == "alc.clip");
        Assert.NotEqual(default, alc);
        Assert.True(alc.Rule.ImmediateAction);
        Assert.Equal(AudioChainSeverity.Error, alc.Rule.Severity);
        Assert.NotNull(alc.Apply);
        Assert.Equal("tx.drive-pct-target", alc.Apply!.Value.Kind);
        // Apply target should be current drive - 15, but not below 1.
        Assert.Equal(45, alc.Apply!.Value.Value);  // 60 − 15
    }

    [Fact]
    public void SwrRunaway_FiresFasterThan_BaseSwrWarn()
    {
        var ev = new RuleEvaluator();
        // Operator keyed into a broken antenna — SWR 4:1 instantly.
        var bad = AllOkUsb with { Swr = 4f, RefWatts = 30 };
        _ = ev.Evaluate(BaseRules.All, bad, SsbCtxMox, T0);

        // At 1.5 s — pa.swr.runaway fires (custom 1.5 s window),
        // pa.swr.warn has NOT fired yet (3 s default warn window).
        var fired15 = ev.Evaluate(BaseRules.All, bad, SsbCtxMox, T0.AddSeconds(1.5));
        Assert.Contains(fired15, f => f.Rule.Name == "pa.swr.runaway");
        Assert.DoesNotContain(fired15, f => f.Rule.Name == "pa.swr.warn");

        // At 3 s — both rules fire. Service-level worst-severity pick
        // (in AudioChainHealthService.BuildSnapshot) ensures the wire
        // carries only the immediate-action one for the PA tile.
        var fired30 = ev.Evaluate(BaseRules.All, bad, SsbCtxMox, T0.AddSeconds(3));
        Assert.Contains(fired30, f => f.Rule.Name == "pa.swr.runaway");
        Assert.Contains(fired30, f => f.Rule.Name == "pa.swr.warn");
    }

    [Fact]
    public void FwdWeak_SuppressedAtLowDrive()
    {
        var ev = new RuleEvaluator();
        // FWD only 1W — but drive is 10%, so the rule should NOT fire
        // (low drive into a clean load is expected to produce low power).
        var quiet = AllOkUsb with { FwdWatts = 1, DrivePct = 10, Swr = 1.0f };
        for (int t = 0; t <= 6; t++)
        {
            var fired = ev.Evaluate(BaseRules.All, quiet, SsbCtxMox, T0.AddSeconds(t));
            Assert.DoesNotContain(fired, f => f.Rule.Name == "pa.fwd.weak");
        }
    }

    [Fact]
    public void FwdWeak_FiresAtHighDriveWithLowFwd()
    {
        var ev = new RuleEvaluator();
        var weak = AllOkUsb with { FwdWatts = 1, DrivePct = 80 };
        _ = ev.Evaluate(BaseRules.All, weak, SsbCtxMox, T0);
        var fired = ev.Evaluate(BaseRules.All, weak, SsbCtxMox, T0.AddSeconds(3.1));
        Assert.Contains(fired, f => f.Rule.Name == "pa.fwd.weak");
    }

    [Fact]
    public void SentinelMicReading_DoesNotTripMicLow()
    {
        var ev = new RuleEvaluator();
        // WDSP not pumping yet — MicAv at the silence sentinel
        // (-400). The rule must read this as "stage idle" rather than
        // "mic at -400 dBFS, ABSURDLY low".
        var sentinel = AllOkUsb with { MicAv = float.NegativeInfinity, MicPk = float.NegativeInfinity };
        for (int t = 0; t <= 5; t++)
        {
            var fired = ev.Evaluate(BaseRules.All, sentinel, SsbCtxMox, T0.AddSeconds(t));
            Assert.DoesNotContain(fired, f => f.Rule.Name == "mic.low");
            Assert.DoesNotContain(fired, f => f.Rule.Name == "mic.hot");
        }
    }

    [Fact]
    public void BaseRuleSet_HasOneOrMoreRulesPerStage_ExceptOptionalGaps()
    {
        // Sanity: the base rule set covers every stage the operator
        // can act on. EQ/Comp/Out have just one rule each (clip-only);
        // Mic/ALC/PA have multiple (low/hot, clip/excessive, etc.).
        // Wire has one (drive ceiling).
        var byStage = BaseRules.All.GroupBy(r => r.Stage).ToDictionary(g => g.Key, g => g.Count());
        Assert.True(byStage[AudioChainStageId.Mic] >= 2);
        Assert.True(byStage[AudioChainStageId.Eq] >= 1);
        Assert.True(byStage[AudioChainStageId.Leveler] >= 1);
        Assert.True(byStage[AudioChainStageId.Cfc] >= 1);
        Assert.True(byStage[AudioChainStageId.Comp] >= 1);
        Assert.True(byStage[AudioChainStageId.Alc] >= 2);
        Assert.True(byStage[AudioChainStageId.Out] >= 1);
        Assert.True(byStage[AudioChainStageId.Wire] >= 1);
        Assert.True(byStage[AudioChainStageId.Pa] >= 2);
    }
}
