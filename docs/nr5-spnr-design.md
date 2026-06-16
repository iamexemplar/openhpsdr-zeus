# NR5 / SPNR Design Note

NR5 is an experimental WDSP-native receive noise-reduction mode for weak-signal
copy. It is not a wrapper around RNNoise/NR3. The first implementation is a
self-contained `spnr` stage in `native/wdsp` that reuses the same post-RXA
placement model as EMNR and SBNR while keeping all NR modes mutually exclusive.

## Goals

- Preserve faint coherent signal structure before suppressing noise.
- Learn the current noise floor online without persisting operator/session data.
- Avoid broad whitening that can erase CW edges, weak carriers, or SSB formants.
- Normalize recovered weak-signal audio with a bounded post-NR output AGC.
- Degrade cleanly when an older bundled `libwdsp` does not export SPNR symbols.

## Algorithm

`spnr.c` runs an overlap-add real STFT over the WDSP RX audio/filter stream.
This is the full demodulated channel band that NR5 is responsible for cleaning,
not the separate panadapter display FFT.

1. Window and transform each frame with the existing WDSP FFTW path.
2. Measure per-bin power for the full frame.
3. Maintain a learned noise estimate with fast startup, slow protected updates,
   and faster updates when a bin looks noise-like.
4. Estimate signal presence from instantaneous SNR plus local spectral salience.
5. Track phase-acceleration stability so a weak coherent bin can be protected
   even when its instantaneous SNR is close to the learned floor.
6. Build a bounded ridge memory from coherence, local salience, neighboring
   presence, and neighboring coherent support so narrow carriers and weak
   formant-like structure survive deeper subtraction.
7. Require localized island support before a bin receives full signal
   protection. Isolated random spikes can no longer keep gain open merely
   because one FFT bin briefly looked phase-stable.
8. Increase floor pressure aggressively on unprotected stochastic bins while
   raising the gain floor around coherent/ridge-protected structure. When the
   prior frame shows sparse coherent islands, NR5 applies extra pressure to
   non-island bins so faint signals sit above a lower effective floor.
9. Apply a Wiener-like attenuation with the adaptive signal-preserving floor.
10. Maintain a decision-directed prior SNR memory per bin. The memory is only
    allowed to influence the mask when local coherence, ridge, or narrow-island
    evidence already exists, which lets faint signals ride through short fades
    without reopening noise-only bins.
11. Smooth gain changes across frames to reduce musical-noise pumping, then
    run an NR2/EMNR-inspired adaptive mask-smoothing pass when the frame is
    under heavy suppression. The pass pulls down isolated stochastic gain
    spikes but backs off around presence, salience, coherence, and ridge
    evidence so weak carriers and formant-like islands are not smeared away.
12. Reconstruct with overlap-add.
13. Build a signal-confidence gate from presence, salience, coherence, and
    ridge memory. The output normalizer uses that gate to authorize leveling,
    then drives confirmed weak and strong signals toward the same target RMS.
    Its RMS envelope follows confirmed weak-signal drops faster than noise-only
    drops, confirmed signals can use a wider makeup range, and explicit gain
    slew limits plus a held level-drive keep the leveling action from audibly
    pumping up and down. Loud-to-weak transitions get extra recovery drive only
    when NR5's confidence and spectral gain evidence still indicate signal
    energy, so the normalizer can lift weak copy after a powerful block without
    simply opening on the floor. A faint-evidence lane combines low input level,
    presence, salience, and gate confidence so buried but coherent blocks can
    accumulate recovery even when instantaneous SNR is marginal. A bounded fast
    makeup stage then gives those confirmed weak blocks immediate lift before
    the final limiter, while a weak-after-strong recovery hold accelerates
    makeup only when current RMS is below target and NR5 confidence/gate
    evidence remains high. Noise-only frames remain constrained by the slow
    gate. The final RMS limiter catches sudden powerful frames above target
    without feeding that limiter reduction back into the long-term AGC gain,
    avoiding fade-out/fade-in recovery cycles after loud bursts.
    A final bounded faint-output rescue runs after makeup and before the
    limiter. It is not persistent AGC state: it only nudges the current weak
    frame up when input is low, NR5 confidence/gate evidence is present, and
    the post-NR output still landed below the input. This targets weak-frame
    dropouts without leaving elevated makeup gain behind for the next block.
14. Report `dynamicRangeDb` against the effective post-NR floor, so diagnostics
    track usable recovered-signal range rather than only the pre-suppression
    learned input floor.

The "self learning" is intentionally local and volatile: NR5 adapts its per-bin
noise, presence, salience, phase coherence, ridge memory, prior SNR, floor
pressure, and output-normalizer gate while it runs, but it does not save learned
state to disk or train a model on operator audio.

## Integration Points

- Native WDSP:
  - `native/wdsp/spnr.c`
  - `native/wdsp/spnr.h`
  - `RXA.c`, `RXA.h`, `comm.h`, `wdsp.h`, and `CMakeLists.txt`
- Managed WDSP seam:
  - `NativeMethods.SetRXASPNR*`
  - `WdspDspEngine.Nr5SpnrAvailable`
  - `WdspDspEngine.SetNoiseReduction(... NrMode.Nr5 ...)`
- Diagnostics:
  - `wdspNr5SpnrAvailable`
  - `nr5Readiness`
  - `nr5SpnrDiagnostics.coherencePeak`
  - `nr5SpnrDiagnostics.ridgePeak`
  - `nr5SpnrDiagnostics.floorReductionDb`
  - `nr5SpnrDiagnostics.dynamicRangeDb`
  - `nr5SpnrDiagnostics.signalConfidence`
  - `nr5SpnrDiagnostics.agcGate`
  - `nr5SpnrDiagnostics.levelDrive`
  - `nr5SpnrDiagnostics.recoveryDrive`
  - `nr5SpnrDiagnostics.makeupGainDb`
  - `readyForNr5Tuning`, `nr5TuningStatus`, and `nr5TuningConstraints`,
    which separate "safe to iterate NR5 from live runtime evidence" from the
    stricter `readyForLiveBenchmark` acceptance gate.
  - `watch-dsp-live-diagnostics.ps1` summary fields under
    `nr5WeakSignalWatch` for weak-input recoveries, weak dropouts, weak output
    below input, hot makeup outliers, weak/strong output gap, and input-to-
    output normalization slope.
  - requested/effective NR mode alignment through `/api/dsp/nr-condition`
- Frontend:
  - NR button cycle includes `NR5`
  - Smart NR may choose NR5 for telemetry-assisted weak signals or coherent
    subthreshold ridges, then downgrade to NR4/NR2 if SPNR is unavailable.

## Tradeoffs

- NR5 is conservative by default. It should favor intelligibility and signal
  preservation over the deepest possible noise subtraction.
- Weak-signal NR5 listening should be evaluated with fixed squelch, ANF, and
  backend auto-AGC disabled. Each can gate or retune the same weak audio that
  NR5 is trying to hold steady, which sounds like fade in/out even when the
  NR5 post-normalizer is stable.
- There are no public NR5 tunables in the first pass. The implementation should
  be judged against synthetic fixtures and on-air listening before exposing
  knobs.
- The output normalizer is bounded and presence-gated. It is not a replacement
  for the main WDSP AGC, and it intentionally leaves headroom.

## Verification Plan

- Build native WDSP with `spnr.c` in the shared library.
- Verify managed fallback when SPNR symbols are missing.
- Extend NR mutual-exclusion tests to include NR5.
- Run Smart NR tests for weak-signal, subthreshold, and capability-downgrade
  cases.
- Add synthetic audio fixtures for buried tone, fading carrier, weak SSB-like
  modulation, impulsive noise with NB off/on, and noise-only stability.
- Capture live NR5 traces with `tools/watch-dsp-live-diagnostics.ps1`; inspect
  `nr5WeakSignalWatch` before changing recovery or makeup constants.
