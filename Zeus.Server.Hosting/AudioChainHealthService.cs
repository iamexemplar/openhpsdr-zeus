// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Zeus.Contracts;
using Zeus.Dsp;
using Zeus.Server.AudioChainHealth;

namespace Zeus.Server;

/// <summary>
/// Audio Chain Monitor — core diagnostic service per ADR-0001. Ticks at
/// 2 Hz, reads the live WDSP TXA stage meters + wire/PA snapshot +
/// operator mode, evaluates the per-mode/per-board rule set, and
/// broadcasts <see cref="AudioChainHealthFrame"/> (MsgType 0x32) carrying
/// only verdicts. Raw stage numbers stay on the existing
/// <c>TxMetersV2</c> / <c>PaTemp</c> frames; the factory widget joins on
/// <see cref="AudioChainStageId"/> in the frontend.
///
/// The base rule set + per-context overrides (zeus-1x4, zeus-y89) are
/// injected via <see cref="IAudioChainRuleProvider"/> so the engine
/// stays decoupled from the concrete thresholds. With an empty rule
/// set the service still ticks and broadcasts — every tile reads OK.
///
/// Apply targets are kept in-process per stage and exposed via
/// <see cref="TryGetApplyAction"/> for the apply endpoint to consume
/// (zeus-pgn).
/// </summary>
public sealed class AudioChainHealthService : BackgroundService
{
    // 2 Hz, matching the cadence committed to in CONTEXT.md and ADR-0002.
    // Verdicts are slow-changing (sustained-violation windows of 3-5 s
    // gate entry per the rule engine), so this is plenty.
    private static readonly TimeSpan Tick = TimeSpan.FromMilliseconds(500);

    private readonly StreamingHub _hub;
    private readonly RadioService _radio;
    private readonly TxService _tx;
    private readonly DspPipelineService _pipe;
    private readonly TxMetersService _txMeters;
    private readonly IAudioChainRuleProvider _rules;
    private readonly ILogger<AudioChainHealthService> _log;
    private readonly RuleEvaluator _evaluator = new();

    // Latest values from TxMetersService — published via its TxMetersUpdated
    // event whenever the 10 Hz MOX loop produces a frame. We subscribe in
    // the constructor and cache the last reading so each 2 Hz health tick
    // reads from a coherent snapshot without re-running the watts/SWR
    // smoothing math.
    private readonly object _txMetersSync = new();
    private float _lastFwdW;
    private float _lastRefW;
    private float _lastSwr = 1.0f;

    // The fixed nine-tile order the factory widget renders left-to-right.
    private static readonly AudioChainStageId[] Stages =
    {
        AudioChainStageId.Mic,
        AudioChainStageId.Eq,
        AudioChainStageId.Leveler,
        AudioChainStageId.Cfc,
        AudioChainStageId.Comp,
        AudioChainStageId.Alc,
        AudioChainStageId.Out,
        AudioChainStageId.Wire,
        AudioChainStageId.Pa,
    };

    // Apply-target cache. The wire never carries the absolute value —
    // the operator clicks Apply, POST /api/audio-chain/apply { stageId }
    // looks here, and the dispatcher (zeus-pgn) routes Kind to the
    // matching backend setter.
    private readonly Dictionary<AudioChainStageId, AudioChainApplyAction> _applyCache = new();
    private readonly object _applySync = new();

    public AudioChainHealthService(
        StreamingHub hub,
        RadioService radio,
        TxService tx,
        DspPipelineService pipe,
        TxMetersService txMeters,
        IAudioChainRuleProvider rules,
        ILogger<AudioChainHealthService> log)
    {
        _hub = hub;
        _radio = radio;
        _tx = tx;
        _pipe = pipe;
        _txMeters = txMeters;
        _rules = rules;
        _log = log;

        // Mirror the watts / SWR values TxMetersService computes — its
        // ADC smoothing + per-board calibration is the source of truth
        // for those readings; we just cache the latest broadcast so the
        // health tick has a coherent snapshot. The handler runs on the
        // 10 Hz MOX broadcast thread; cheap field assignments under a
        // lock keep the read path race-free.
        _txMeters.TxMetersUpdated += OnTxMetersUpdated;
    }

    private void OnTxMetersUpdated(float fwdW, float refW, float swr, float alcPk, float alcGr)
    {
        lock (_txMetersSync)
        {
            _lastFwdW = fwdW;
            _lastRefW = refW;
            _lastSwr = swr;
        }
    }

    public override void Dispose()
    {
        _txMeters.TxMetersUpdated -= OnTxMetersUpdated;
        base.Dispose();
    }

    /// <summary>
    /// Look up the current absolute apply target for a stage. Returns
    /// false if the stage has no fired apply-capable verdict at the
    /// moment — the apply endpoint should reject with 404 in that case.
    /// </summary>
    public bool TryGetApplyAction(AudioChainStageId stage, out AudioChainApplyAction action)
    {
        lock (_applySync)
        {
            return _applyCache.TryGetValue(stage, out action);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var ticker = new PeriodicTimer(Tick);
        try
        {
            while (await ticker.WaitForNextTickAsync(ct).ConfigureAwait(false))
            {
                try
                {
                    var frame = BuildSnapshot(DateTime.UtcNow);
                    _hub.Broadcast(frame);
                }
                catch (Exception ex)
                {
                    // Per-tick failure should never take down the service —
                    // log and skip this tick; the next tick re-reads state
                    // fresh.
                    _log.LogWarning(ex, "audio-chain-health tick failed");
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
    }

    internal AudioChainHealthFrame BuildSnapshot(DateTime nowUtc)
    {
        var state = _radio.Snapshot();
        var stages = _pipe.CurrentEngine?.GetTxStageMeters() ?? TxStageMeters.Silent;
        bool mox = _tx.IsMoxOn || _tx.IsTunOn;

        float fwdW, refW, swr;
        lock (_txMetersSync)
        {
            fwdW = _lastFwdW;
            refW = _lastRefW;
            swr = _lastSwr;
        }
        var readings = AudioChainReadings.FromTxStageMeters(
            s: stages,
            drivePct: state.DrivePct,
            // DriveByte not yet on the in-process surface (TxMetersService
            // logs it but the value isn't exposed). Placeholder until
            // wired; the Wire ceiling rule keys off DrivePct for now.
            driveByte: 0,
            fwdWatts: fwdW,
            refWatts: refW,
            swr: swr);
        var ctx = new RuleContext(
            Mode: state.Mode,
            Board: _radio.ConnectedBoardKind,
            Mox: mox);

        var fired = _evaluator.Evaluate(_rules.Rules, in readings, in ctx, nowUtc);

        // Worst-severity-per-stage wins; the wire carries exactly one
        // verdict per stage (the factory widget renders one pill per
        // tile). The advisory rail surfaces the top three by severity
        // — that's a frontend concern, but the wire still needs to be
        // unambiguous about which verdict belongs to each tile.
        var worstPerStage = new Dictionary<AudioChainStageId, FiredRule>();
        foreach (var f in fired)
        {
            if (!worstPerStage.TryGetValue(f.Rule.Stage, out var existing) ||
                SeverityRank(f.Rule) > SeverityRank(existing.Rule))
            {
                worstPerStage[f.Rule.Stage] = f;
            }
        }

        // Apply-cache snapshot. Rebuild from scratch each tick so a
        // cleared verdict doesn't leave a stale target behind.
        lock (_applySync)
        {
            _applyCache.Clear();
            foreach (var (stage, f) in worstPerStage)
            {
                if (f.Apply is { } a)
                    _applyCache[stage] = a;
            }
        }

        var verdicts = new AudioChainVerdict[Stages.Length];
        for (int i = 0; i < Stages.Length; i++)
        {
            var id = Stages[i];
            if (worstPerStage.TryGetValue(id, out var f))
            {
                var flags = AudioChainVerdictFlags.None;
                if (f.Rule.ImmediateAction) flags |= AudioChainVerdictFlags.ImmediateAction;
                if (f.Apply is not null) flags |= AudioChainVerdictFlags.HasApply;
                verdicts[i] = new AudioChainVerdict(
                    StageId: id,
                    Severity: f.Rule.Severity,
                    Flags: flags,
                    Message: f.Message,
                    ApplyLabel: f.ApplyLabel);
            }
            else
            {
                verdicts[i] = AudioChainVerdict.Ok(id);
            }
        }
        return new AudioChainHealthFrame(state.Mode, verdicts);
    }

    private static int SeverityRank(AudioChainRule r) =>
        r.Severity == AudioChainSeverity.Error
            ? (r.ImmediateAction ? 4 : 3)
            : r.Severity == AudioChainSeverity.Warn
                ? 2
                : r.Severity == AudioChainSeverity.Info
                    ? 1
                    : 0;
}

/// <summary>
/// Source of truth for the active rule set. Injected so tests can
/// supply a fixture rule list and the runtime service can build the
/// base set + per-context overrides separately (zeus-1x4 / zeus-y89).
/// </summary>
public interface IAudioChainRuleProvider
{
    IReadOnlyList<AudioChainRule> Rules { get; }
}

/// <summary>
/// Default provider — exposes an empty rule set so the service is
/// fully wired before the base rule set lands. Replaced by the
/// concrete provider in zeus-1x4.
/// </summary>
public sealed class EmptyAudioChainRuleProvider : IAudioChainRuleProvider
{
    public IReadOnlyList<AudioChainRule> Rules { get; } = Array.Empty<AudioChainRule>();
}
