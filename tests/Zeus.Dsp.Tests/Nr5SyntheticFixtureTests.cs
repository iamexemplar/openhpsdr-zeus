// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus - OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF),
//                         Douglas J. Cerrato (KB2UKA), and contributors.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 2 of the License, or (at your
// option) any later version. See the LICENSE file at the root of this
// repository for the full text, or https://www.gnu.org/licenses/.

using Zeus.Contracts;
using Zeus.Dsp.Wdsp;
using Xunit;

namespace Zeus.Dsp.Tests;

[Collection("Wdsp")]
public class Nr5SyntheticFixtureTests
{
    private const int AudioSampleRateHz = 48_000;
    private const int PixelWidth = 2048;
    private const int ChunkComplex = 126;
    private const int FixtureRepeats = 4;
    private const int MinimumAudioSamples = 8_192;
    private const int AnalysisSamples = 16_384;

    private static readonly DspBenchmarkScenarioKind[] RequiredNr5FixtureKinds =
    [
        DspBenchmarkScenarioKind.WeakCarrier,
        DspBenchmarkScenarioKind.SsbLikeSpeech,
        DspBenchmarkScenarioKind.FadingCarrier,
        DspBenchmarkScenarioKind.ImpulseNoise,
        DspBenchmarkScenarioKind.StrongAdjacent,
        DspBenchmarkScenarioKind.AgcStep,
        DspBenchmarkScenarioKind.SquelchTransition,
        DspBenchmarkScenarioKind.NoiseOnly
    ];

    private static bool WdspAvailable()
    {
        try { return WdspNativeLoader.TryProbe(); }
        catch { return false; }
    }

    private static bool SbnrAvailable()
    {
        try { return WdspDspEngine.Nr4SbnrAvailable; }
        catch { return false; }
    }

    private static bool SpnrAvailable()
    {
        try { return WdspDspEngine.Nr5SpnrAvailable; }
        catch { return false; }
    }

    [Fact]
    public void Nr5FixtureCatalog_CoversRequiredWeakSignalScenes()
    {
        var names = DspBenchmarkFixtureCatalog.All().Select(fixture => fixture.Name).ToHashSet(StringComparer.Ordinal);

        Assert.Contains("weak-cw-carrier", names);
        Assert.Contains("ssb-like-speech", names);
        Assert.Contains("fading-carrier", names);
        Assert.Contains("impulse-noise", names);
        Assert.Contains("strong-adjacent", names);
        Assert.Contains("agc-level-step", names);
        Assert.Contains("squelch-transition", names);
        Assert.Contains("noise-only", names);

        foreach (var kind in RequiredNr5FixtureKinds)
        {
            var fixture = DspBenchmarkFixtureCatalog.Create(kind);
            Assert.Equal(DspBenchmarkPath.RxIq, fixture.Path);
            Assert.Equal(DspBenchmarkFixtureCatalog.RxSampleRateHz, fixture.SampleRateHz);
            Assert.True(fixture.SampleCount > 0, $"{fixture.Name} has no IQ samples");
        }
    }

    [SkippableFact]
    public void Wdsp_Nr5WeakSignalFixtures_PreserveSignalsAgainstOffNr2Nr4()
    {
        Skip.IfNot(WdspAvailable(), "libwdsp not available");
        Skip.IfNot(SpnrAvailable(), "Requires libwdsp rebuild with NR5/SPNR exports.");

        foreach (var kind in new[]
                 {
                     DspBenchmarkScenarioKind.WeakCarrier,
                     DspBenchmarkScenarioKind.SsbLikeSpeech,
                     DspBenchmarkScenarioKind.FadingCarrier
                 })
        {
            var fixture = DspBenchmarkFixtureCatalog.Create(kind);
            var results = RunComparisons(fixture, includeNr4WhenAvailable: true);
            var off = results.Single(result => result.NrMode == NrMode.Off);
            var nr5 = results.Single(result => result.NrMode == NrMode.Nr5);

            Assert.Contains(results, result => result.NrMode == NrMode.Emnr);
            if (SbnrAvailable())
                Assert.Contains(results, result => result.NrMode == NrMode.Sbnr);

            foreach (var result in results)
                AssertHealthyOutput(result);

            AssertLevelNormalized(nr5, off, maxRatio: 4.0);

            foreach (var tone in fixture.ExpectedTonesHz.Keys)
            {
                double offTone = off.Metrics.TonePowerDb[tone];
                double nr5Tone = nr5.Metrics.TonePowerDb[tone];
                Assert.True(
                    nr5Tone > offTone - 18.0,
                    $"{fixture.Name}/{tone}: NR5 should preserve wanted energy within 18 dB of NR-off. off={offTone:F1}dB nr5={nr5Tone:F1}dB nr5Result={Describe(nr5)} nr5Diag={DescribeNr5(nr5.Nr5Diagnostics)}");
            }

            Assert.True(
                nr5.Nr5Diagnostics is { Run: true, LearnedFrames: > 0 },
                $"{fixture.Name}: expected NR5 diagnostics to show a running, learned SPNR stage");
        }
    }

    [SkippableFact]
    public void Wdsp_Nr5NoiseOnlyFixture_RemainsStableAgainstOffNr2Nr4()
    {
        Skip.IfNot(WdspAvailable(), "libwdsp not available");
        Skip.IfNot(SpnrAvailable(), "Requires libwdsp rebuild with NR5/SPNR exports.");

        var fixture = DspBenchmarkFixtureCatalog.Create(DspBenchmarkScenarioKind.NoiseOnly);
        var results = RunComparisons(fixture, includeNr4WhenAvailable: true);
        var off = results.Single(result => result.NrMode == NrMode.Off);
        var nr5 = results.Single(result => result.NrMode == NrMode.Nr5);

        Assert.Contains(results, result => result.NrMode == NrMode.Emnr);
        if (SbnrAvailable())
            Assert.Contains(results, result => result.NrMode == NrMode.Sbnr);

        foreach (var result in results)
            AssertHealthyOutput(result);

        AssertLevelNormalized(nr5, off, maxRatio: 3.0);
        Assert.True(
            nr5.Metrics.WindowedRmsSpreadDb <= off.Metrics.WindowedRmsSpreadDb + 10.0,
            $"noise-only NR5 should not introduce unstable pumping. offSpread={off.Metrics.WindowedRmsSpreadDb:F1}dB nr5Spread={nr5.Metrics.WindowedRmsSpreadDb:F1}dB");

        if (nr5.Nr5Diagnostics is { } diag && WdspDspEngine.Nr5SpnrDeepDiagnosticsAvailable)
        {
            Assert.InRange(diag.SignalConfidence, 0.0, 0.55);
            Assert.InRange(diag.AgcGate, 0.0, 0.55);
        }
    }

    [SkippableFact]
    public void Wdsp_Nr5ImpulseFixture_RunsWithNbOffAndNbOnWithoutClipping()
    {
        Skip.IfNot(WdspAvailable(), "libwdsp not available");
        Skip.IfNot(SpnrAvailable(), "Requires libwdsp rebuild with NR5/SPNR exports.");

        var fixture = DspBenchmarkFixtureCatalog.Create(DspBenchmarkScenarioKind.ImpulseNoise);
        var nbOff = RunFixture(fixture, new NrConfig(NrMode: NrMode.Nr5));
        var nbOn = RunFixture(fixture, new NrConfig(NrMode: NrMode.Nr5, NbMode: NbMode.Nb1, NbThreshold: 50.0));

        AssertHealthyOutput(nbOff);
        AssertHealthyOutput(nbOn);
        AssertLevelNormalized(nbOn, nbOff, maxRatio: 3.0);
        Assert.True(
            nbOn.Metrics.Peak <= nbOff.Metrics.Peak * 2.0 + 0.05,
            $"NB1+NR5 impulse peak should stay bounded. nbOff={Describe(nbOff)} nbOn={Describe(nbOn)}");
    }

    [SkippableFact]
    public void Wdsp_Nr5StrongAdjacentFixture_PreservesWantedSignalWithoutLiftingBlocker()
    {
        Skip.IfNot(WdspAvailable(), "libwdsp not available");
        Skip.IfNot(SpnrAvailable(), "Requires libwdsp rebuild with NR5/SPNR exports.");

        var fixture = DspBenchmarkFixtureCatalog.Create(DspBenchmarkScenarioKind.StrongAdjacent);
        var off = RunFixture(fixture, new NrConfig(NrMode: NrMode.Off));
        var nr5 = RunFixture(fixture, new NrConfig(NrMode: NrMode.Nr5));

        AssertHealthyOutput(off);
        AssertHealthyOutput(nr5);
        AssertLevelNormalized(nr5, off, maxRatio: 4.0);

        double offWanted = off.Metrics.TonePowerDb["wanted"];
        double nr5Wanted = nr5.Metrics.TonePowerDb["wanted"];
        double nr5Adjacent = nr5.Metrics.TonePowerDb["adjacent"];

        Assert.True(
            nr5Wanted > offWanted - 18.0,
            $"strong-adjacent: NR5 should preserve wanted passband energy. offWanted={offWanted:F1}dB nr5Wanted={nr5Wanted:F1}dB nr5={Describe(nr5)} nr5Diag={DescribeNr5(nr5.Nr5Diagnostics)}");
        Assert.True(
            nr5Wanted > nr5Adjacent - 12.0,
            $"strong-adjacent: out-of-passband blocker should not dominate NR5 output. wanted={nr5Wanted:F1}dB adjacent={nr5Adjacent:F1}dB nr5={Describe(nr5)} nr5Diag={DescribeNr5(nr5.Nr5Diagnostics)}");
    }

    [SkippableFact]
    public void Wdsp_Nr5AgcStepFixture_KeepsLevelMovementBounded()
    {
        Skip.IfNot(WdspAvailable(), "libwdsp not available");
        Skip.IfNot(SpnrAvailable(), "Requires libwdsp rebuild with NR5/SPNR exports.");

        var fixture = DspBenchmarkFixtureCatalog.Create(DspBenchmarkScenarioKind.AgcStep);
        var off = RunFixture(fixture, new NrConfig(NrMode: NrMode.Off));
        var nr5 = RunFixture(fixture, new NrConfig(NrMode: NrMode.Nr5));

        AssertHealthyOutput(off);
        AssertHealthyOutput(nr5);
        AssertLevelNormalized(nr5, off, maxRatio: 4.0);

        Assert.True(
            nr5.Metrics.WindowedRmsSpreadDb <= off.Metrics.WindowedRmsSpreadDb + 8.0,
            $"AGC-step NR5 should not add audible pumping beyond NR-off. offSpread={off.Metrics.WindowedRmsSpreadDb:F1}dB nr5Spread={nr5.Metrics.WindowedRmsSpreadDb:F1}dB off={Describe(off)} nr5={Describe(nr5)} nr5Diag={DescribeNr5(nr5.Nr5Diagnostics)}");
    }

    private static IReadOnlyList<WdspFixtureResult> RunComparisons(
        DspBenchmarkFixture fixture,
        bool includeNr4WhenAvailable)
    {
        var results = new List<WdspFixtureResult>
        {
            RunFixture(fixture, new NrConfig(NrMode: NrMode.Off)),
            RunFixture(fixture, new NrConfig(NrMode: NrMode.Emnr))
        };

        if (includeNr4WhenAvailable && SbnrAvailable())
            results.Add(RunFixture(fixture, new NrConfig(NrMode: NrMode.Sbnr)));

        results.Add(RunFixture(fixture, new NrConfig(NrMode: NrMode.Nr5)));
        return results;
    }

    private static WdspFixtureResult RunFixture(DspBenchmarkFixture fixture, NrConfig nr)
    {
        if (fixture.Path != DspBenchmarkPath.RxIq || fixture.IqInterleaved is null)
            throw new ArgumentException("NR5 WDSP fixture runner requires RX IQ fixtures.", nameof(fixture));

        using var engine = new WdspDspEngine();
        int channel = engine.OpenChannel(fixture.SampleRateHz, PixelWidth);
        try
        {
            engine.SetMode(channel, RxMode.USB);
            engine.SetFilter(channel, 150, 2850);
            engine.SetVfoHz(channel, 14_200_000);
            engine.SetAgcTop(channel, 80.0);
            engine.SetNoiseReduction(channel, nr);

            for (int repeat = 0; repeat < FixtureRepeats; repeat++)
                FeedFixtureIq(engine, channel, fixture.IqInterleaved);

            var audio = DrainAudio(engine, channel);
            Assert.True(
                audio.Length >= MinimumAudioSamples,
                $"{fixture.Name}/{nr.NrMode}/{nr.NbMode}: expected at least {MinimumAudioSamples} audio samples, got {audio.Length}");

            float[] analysis = Tail(audio, AnalysisSamples);
            var metrics = DspBenchmarkAnalyzer.AnalyzeAudio(analysis, AudioSampleRateHz, fixture.ExpectedTonesHz);
            Nr5SpnrDiagnosticsDto? diagnostics = nr.NrMode == NrMode.Nr5
                ? engine.TryGetNr5SpnrDiagnostics(channel)
                : null;

            return new WdspFixtureResult(fixture.Name, nr.NrMode, nr.NbMode, analysis.Length, metrics, diagnostics);
        }
        finally
        {
            engine.CloseChannel(channel);
        }
    }

    private static void FeedFixtureIq(WdspDspEngine engine, int channel, double[] iq)
    {
        int complexSamples = iq.Length / 2;
        for (int offset = 0; offset < complexSamples; offset += ChunkComplex)
        {
            int take = Math.Min(ChunkComplex, complexSamples - offset);
            engine.FeedIq(channel, iq.AsSpan(2 * offset, 2 * take));
        }
    }

    private static float[] DrainAudio(WdspDspEngine engine, int channel)
    {
        var samples = new List<float>(AnalysisSamples * 2);
        var buffer = new float[2048];

        for (int i = 0; i < 160; i++)
        {
            Thread.Sleep(10);
            int drained = engine.ReadAudio(channel, buffer);
            if (drained > 0)
                samples.AddRange(buffer.Take(drained));
            if (samples.Count >= AnalysisSamples * 2)
                break;
        }

        return samples.ToArray();
    }

    private static float[] Tail(float[] samples, int count)
    {
        int take = Math.Min(samples.Length, count);
        var tail = new float[take];
        Array.Copy(samples, samples.Length - take, tail, 0, take);
        return tail;
    }

    private static void AssertHealthyOutput(WdspFixtureResult result)
    {
        var metrics = result.Metrics;
        AssertFinite(metrics.Rms, $"{result.Label} RMS");
        AssertFinite(metrics.Peak, $"{result.Label} peak");
        AssertFinite(metrics.CrestFactorDb, $"{result.Label} crest factor");
        AssertFinite(metrics.DcOffset, $"{result.Label} DC offset");
        AssertFinite(metrics.WindowedRmsSpreadDb, $"{result.Label} window spread");

        Assert.True(metrics.Rms > 1e-7, $"{result.Label}: expected non-silent output");
        Assert.True(metrics.Rms < 0.50, $"{result.Label}: output RMS too high ({Describe(result)})");
        Assert.True(metrics.Peak < 0.98, $"{result.Label}: output peak approaches clipping ({Describe(result)})");
        Assert.True(Math.Abs(metrics.DcOffset) < 0.05, $"{result.Label}: unexpected DC offset ({Describe(result)})");
    }

    private static void AssertLevelNormalized(WdspFixtureResult candidate, WdspFixtureResult baseline, double maxRatio)
    {
        double ratio = candidate.Metrics.Rms / Math.Max(baseline.Metrics.Rms, 1e-9);
        Assert.True(
            ratio <= maxRatio,
            $"{candidate.Label}: RMS rose too far over {baseline.Label}. ratio={ratio:F2} candidate={Describe(candidate)} baseline={Describe(baseline)}");
        Assert.True(
            ratio >= 0.03,
            $"{candidate.Label}: RMS collapsed relative to {baseline.Label}. ratio={ratio:F2} candidate={Describe(candidate)} baseline={Describe(baseline)}");
    }

    private static void AssertFinite(double value, string label)
    {
        Assert.False(double.IsNaN(value), $"{label} is NaN");
        Assert.False(double.IsInfinity(value), $"{label} is infinite");
    }

    private static string Describe(WdspFixtureResult result) =>
        $"{result.Label} samples={result.SampleCount} rms={result.Metrics.Rms:F5} peak={result.Metrics.Peak:F5} spread={result.Metrics.WindowedRmsSpreadDb:F1}dB";

    private static string DescribeNr5(Nr5SpnrDiagnosticsDto? diag) =>
        diag is null
            ? "null"
            : $"learned={diag.LearnedFrames} conf={diag.SignalConfidence:F3} gate={diag.AgcGate:F3} " +
              $"presence={diag.PresencePeak:F3} salience={diag.SaliencePeak:F3} " +
              $"coherence={diag.CoherencePeak:F3} ridge={diag.RidgePeak:F3} " +
              $"meanGain={diag.MeanGain:F3} minGain={diag.MinGain:F3} " +
              $"levelDrive={diag.LevelDrive:F3} recovery={diag.RecoveryDrive:F3} makeup={diag.MakeupGainDb:F1}dB " +
              $"floor={diag.FloorReductionDb:F1}dB dr={diag.DynamicRangeDb:F1}dB " +
              $"in={diag.InputRms:F5} out={diag.OutputRms:F5} agcGain={diag.AgcGain:F3}";

    private sealed record WdspFixtureResult(
        string FixtureName,
        NrMode NrMode,
        NbMode NbMode,
        int SampleCount,
        DspBenchmarkMetrics Metrics,
        Nr5SpnrDiagnosticsDto? Nr5Diagnostics)
    {
        public string Label => $"{FixtureName}/{NrMode}/{NbMode}";
    }
}
