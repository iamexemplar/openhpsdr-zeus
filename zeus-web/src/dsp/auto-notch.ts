// SPDX-License-Identifier: GPL-2.0-or-later
//
// Detect persistent narrow EMF/RFI bars and express them as manual-notch bands.

import type { Notch } from '../state/notch-store';

export type AutoNotchCandidate = {
  centerHz: number;
  widthHz: number;
  snrDb: number;
  confidence: number;
};

export type AutoNotchTrack = AutoNotchCandidate & {
  hits: number;
  misses: number;
  verified: boolean;
  locked: boolean;
  lockedCenterHz: number;
  lockedWidthHz: number;
  centerJitterHz: number;
  widthJitterHz: number;
};

export type AutoNotchInput = {
  spectrum: Float32Array | null;
  floor: Float32Array | null;
  /** Per-bin temporal coherence (legacy/diagnostic; not a detection gate). */
  confidence: Float32Array | null;
  /** Per-bin amplitude steadiness 0..1 — the carrier-vs-voice discriminant. */
  stationarity: Float32Array | null;
  centerHz: bigint | number;
  hzPerPixel: number;
  existingNotches?: readonly Notch[];
};

export type AutoNotchTrackerOptions = {
  verifySamples?: number;
  provisionalMisses?: number;
  holdMisses?: number;
  matchHz?: number;
  refineAlpha?: number;
};

export type AutoNotchTracker = {
  update: (candidates: readonly AutoNotchCandidate[], manualNotches?: readonly Notch[]) => AutoNotchTrack[];
  clear: () => void;
  snapshot: () => AutoNotchTrack[];
};

// Carrier-line detection gates. The detector's only job is to find STEADY,
// NARROW carriers/heterodynes the operator wants notched and to leave SSB/AM
// voice alone. Three orthogonal gates, ANDed together (see
// docs/designs/auto-notch-carrier-detector.md):
//
//   • PROMINENCE — how far the peak stands above its own local saddle (the
//     higher of the two basin minima bounding it), measured topographically.
//     This REPLACES "SNR above the CFAR floor" as the primary gate: a strong
//     carrier whose own FFT leakage skirts lift the spatial floor (CFAR self-
//     masking) still towers over its local saddles, so it is no longer missed.
//     A voice formant riding a broad hump has little prominence over the hump.
//   • NARROWNESS — width measured at a fixed dB drop from the peak. A carrier is
//     1–3 bins wide; an SSB voice hump stays up for hundreds of Hz to ~2.7 kHz.
//     This is what stops the low-end of voice from ever qualifying.
//   • STATIONARITY — amplitude steadiness over time (signal-estimator). A
//     carrier's level is constant; voice swings with the 2–10 Hz syllabic
//     envelope. This is the decisive carrier-vs-voice discriminant.
const MIN_SNR_DB = 9; // light prefilter — prominence is the real level gate
const MIN_PROMINENCE_DB = 10; // peak must stand this far above its local saddle
const PROMINENCE_WINDOW_HZ = 3_000; // ± window the saddle reference is taken over
const WIDTH_DROP_DB = 6; // carrier width is measured at −6 dB from the peak
const MAX_CARRIER_WIDTH_HZ = 500; // wider than this is a signal/voice, not a carrier
const MIN_STEADINESS = 0.6; // amplitude-stationarity gate (0..1; carriers ≳ 0.85)
const NOTCH_PAD_HZ = 30; // pad each side of the measured carrier width
const MIN_WIDTH_HZ = 45;
const NARROW_MAX_WIDTH_HZ = 750; // tracker required-hits boundary
const MAX_WIDTH_HZ = 600; // an emitted notch never exceeds a narrow carrier band
const MERGE_HZ = 120;
const MAX_AUTO_NOTCHES = 16;
const VERIFY_SAMPLES = 3;
const WIDE_VERIFY_SAMPLES = 5;
const PROVISIONAL_MISSES = 2;
const VERIFIED_HOLD_MISSES = 8;
const TRACK_MATCH_HZ = 180;
const REFINE_ALPHA = 0.22;
const OUTPUT_QUANTUM_HZ = 10;
const TRACK_JITTER_ALPHA = 0.28;
const CENTER_JITTER_MIN_HZ = 90;
const CENTER_JITTER_MAX_HZ = 900;
const CENTER_JITTER_WIDTH_FRACTION = 0.22;
const WIDTH_JITTER_MIN_HZ = 120;
const WIDTH_JITTER_MAX_HZ = 1_500;
const WIDTH_JITTER_WIDTH_FRACTION = 0.35;
const LOCK_DRIFT_WIDTH_FRACTION = 0.45;

function finite(v: number): boolean {
  return Number.isFinite(v);
}

function binToHz(bin: number, n: number, centerHz: number, hzPerPixel: number): number {
  return centerHz + (bin - n / 2) * hzPerPixel;
}

function overlaps(aCenter: number, aWidth: number, bCenter: number, bWidth: number): boolean {
  return Math.abs(aCenter - bCenter) <= (aWidth + bWidth) / 2;
}

function isCoveredByManualNotch(
  candidate: AutoNotchCandidate,
  notches: readonly Notch[],
): boolean {
  return notches.some((n) =>
    n.source !== 'auto' && overlaps(candidate.centerHz, candidate.widthHz, n.centerHz, n.widthHz),
  );
}

function candidateSort(a: AutoNotchCandidate, b: AutoNotchCandidate): number {
  const as = a.snrDb * (0.6 + a.confidence);
  const bs = b.snrDb * (0.6 + b.confidence);
  return bs - as;
}

function clampWidth(widthHz: number): number {
  return Math.max(MIN_WIDTH_HZ, Math.min(MAX_WIDTH_HZ, widthHz));
}

/** Topographic prominence of the peak at `i`, in dB: peak minus the higher of
 *  the two local saddle minima within ±windowBins. Walking outward stops when
 *  the spectrum rises above the peak (the basin edge) or the window/array ends.
 *  Robust to a tilted or skirt-lifted baseline in a way that peak-minus-CFAR is
 *  not — this is the fix for a strong carrier self-masking its own floor. */
function saddleProminenceDb(spec: Float32Array, i: number, windowBins: number): number {
  const peak = spec[i]!;
  const loEdge = Math.max(0, i - windowBins);
  const hiEdge = Math.min(spec.length - 1, i + windowBins);
  let leftMin = peak;
  for (let j = i - 1; j >= loEdge; j--) {
    const v = spec[j]!;
    if (!finite(v) || v > peak) break;
    if (v < leftMin) leftMin = v;
  }
  let rightMin = peak;
  for (let j = i + 1; j <= hiEdge; j++) {
    const v = spec[j]!;
    if (!finite(v) || v > peak) break;
    if (v < rightMin) rightMin = v;
  }
  return peak - Math.max(leftMin, rightMin);
}

/** Width in Hz of the contiguous run around the peak that stays at or above
 *  `threshold` dB (peak − WIDTH_DROP_DB). A carrier collapses within a couple of
 *  bins; a voice hump stays above the −6 dB line for hundreds of Hz. */
function widthAtDropHz(spec: Float32Array, i: number, threshold: number, hzPerPixel: number): number {
  let lo = i;
  let hi = i;
  while (lo > 0 && finite(spec[lo - 1]!) && spec[lo - 1]! >= threshold) lo--;
  while (hi < spec.length - 1 && finite(spec[hi + 1]!) && spec[hi + 1]! >= threshold) hi++;
  return (hi - lo + 1) * hzPerPixel;
}

function quantizeHz(value: number): number {
  return Math.round(value / OUTPUT_QUANTUM_HZ) * OUTPUT_QUANTUM_HZ;
}

function cloneTrack(t: AutoNotchTrack): AutoNotchTrack {
  return { ...t };
}

function outputTrack(t: AutoNotchTrack): AutoNotchTrack {
  const centerHz = t.locked ? t.lockedCenterHz : t.centerHz;
  const widthHz = t.locked ? t.lockedWidthHz : t.widthHz;
  return {
    ...t,
    centerHz: quantizeHz(centerHz),
    widthHz: clampWidth(quantizeHz(widthHz)),
  };
}

function isCoveredByManualTrack(track: AutoNotchTrack, notches: readonly Notch[]): boolean {
  return isCoveredByManualNotch(track, notches);
}

export function createAutoNotchTracker(options: AutoNotchTrackerOptions = {}): AutoNotchTracker {
  const verifySamples = Math.max(1, Math.round(options.verifySamples ?? VERIFY_SAMPLES));
  const provisionalMisses = Math.max(0, Math.round(options.provisionalMisses ?? PROVISIONAL_MISSES));
  const holdMisses = Math.max(provisionalMisses, Math.round(options.holdMisses ?? VERIFIED_HOLD_MISSES));
  const matchHz = Math.max(20, options.matchHz ?? TRACK_MATCH_HZ);
  const refineAlpha = Math.max(0.02, Math.min(1, options.refineAlpha ?? REFINE_ALPHA));
  let tracks: AutoNotchTrack[] = [];

  const requiredHits = (track: AutoNotchTrack): number =>
    track.widthHz > NARROW_MAX_WIDTH_HZ ? Math.max(verifySamples, WIDE_VERIFY_SAMPLES) : verifySamples;

  const stableEnough = (track: AutoNotchTrack): boolean => {
    const centerLimit = Math.max(
      CENTER_JITTER_MIN_HZ,
      Math.min(CENTER_JITTER_MAX_HZ, track.widthHz * CENTER_JITTER_WIDTH_FRACTION),
    );
    const widthLimit = Math.max(
      WIDTH_JITTER_MIN_HZ,
      Math.min(WIDTH_JITTER_MAX_HZ, track.widthHz * WIDTH_JITTER_WIDTH_FRACTION),
    );
    return track.centerJitterHz <= centerLimit && track.widthJitterHz <= widthLimit;
  };

  const lockIfReady = (track: AutoNotchTrack): void => {
    if (track.verified || track.hits < requiredHits(track) || !stableEnough(track)) return;
    const out = outputTrack(track);
    track.verified = true;
    track.locked = true;
    track.lockedCenterHz = out.centerHz;
    track.lockedWidthHz = out.widthHz;
  };

  const clear = () => {
    tracks = [];
  };

  const snapshot = () => tracks.map(cloneTrack);

  const update = (
    candidates: readonly AutoNotchCandidate[],
    manualNotches: readonly Notch[] = [],
  ): AutoNotchTrack[] => {
    const ordered = [...candidates].sort(candidateSort);
    const used = new Set<number>();

    for (const track of tracks) {
      let bestIdx = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < ordered.length; i++) {
        if (used.has(i)) continue;
        const candidate = ordered[i]!;
        const distance = Math.abs(candidate.centerHz - track.centerHz);
        const gate = Math.max(matchHz, (candidate.widthHz + track.widthHz) / 2);
        if (
          track.locked &&
          Math.abs(candidate.centerHz - track.lockedCenterHz) >
            Math.max(matchHz, track.lockedWidthHz * LOCK_DRIFT_WIDTH_FRACTION)
        ) {
          continue;
        }
        if (distance <= gate && distance < bestDistance) {
          bestDistance = distance;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const candidate = ordered[bestIdx]!;
        used.add(bestIdx);
        const centerDelta = Math.abs(candidate.centerHz - track.centerHz);
        const widthDelta = Math.abs(candidate.widthHz - track.widthHz);
        track.centerJitterHz += (centerDelta - track.centerJitterHz) * TRACK_JITTER_ALPHA;
        track.widthJitterHz += (widthDelta - track.widthJitterHz) * TRACK_JITTER_ALPHA;
        track.centerHz += (candidate.centerHz - track.centerHz) * refineAlpha;
        track.widthHz = clampWidth(track.widthHz + (candidate.widthHz - track.widthHz) * refineAlpha);
        track.snrDb += (candidate.snrDb - track.snrDb) * refineAlpha;
        track.confidence += (candidate.confidence - track.confidence) * refineAlpha;
        track.hits += 1;
        track.misses = 0;
        lockIfReady(track);
      } else {
        track.misses += 1;
      }
    }

    for (let i = 0; i < ordered.length; i++) {
      if (used.has(i)) continue;
      const candidate = ordered[i]!;
      const track: AutoNotchTrack = {
        centerHz: candidate.centerHz,
        widthHz: clampWidth(candidate.widthHz),
        snrDb: candidate.snrDb,
        confidence: candidate.confidence,
        hits: 1,
        misses: 0,
        verified: false,
        locked: false,
        lockedCenterHz: candidate.centerHz,
        lockedWidthHz: clampWidth(candidate.widthHz),
        centerJitterHz: 0,
        widthJitterHz: 0,
      };
      lockIfReady(track);
      tracks.push(track);
    }

    tracks = tracks
      .filter((track) => !isCoveredByManualTrack(track, manualNotches))
      .filter((track) => track.misses <= (track.verified ? holdMisses : provisionalMisses))
      .sort(candidateSort)
      .slice(0, MAX_AUTO_NOTCHES)
      .sort((a, b) => a.centerHz - b.centerHz);

    return tracks
      .filter((track) => track.verified)
      .map(outputTrack);
  };

  return { update, clear, snapshot };
}

export function detectAutoNotches(input: AutoNotchInput): AutoNotchCandidate[] {
  const spec = input.spectrum;
  const floor = input.floor;
  const steady = input.stationarity;
  const hzPerPixel = input.hzPerPixel;
  // Stationarity is required: without it we cannot tell a carrier from voice,
  // and emitting on prominence alone would re-introduce the voice-eating bug.
  // Fail safe to "no notches" rather than guess.
  if (!spec || !floor || !steady || spec.length < 8) return [];
  const n = spec.length;
  if (floor.length !== n || steady.length !== n || !finite(hzPerPixel) || hzPerPixel <= 0) return [];
  const centerHz = Number(input.centerHz);
  if (!finite(centerHz)) return [];

  const windowBins = Math.max(2, Math.round(PROMINENCE_WINDOW_HZ / hzPerPixel));
  const raw: AutoNotchCandidate[] = [];

  for (let i = 1; i < n - 1; i++) {
    const here = spec[i]!;
    const left = spec[i - 1]!;
    const right = spec[i + 1]!;
    if (!finite(here) || !finite(left) || !finite(right)) continue;
    // Local maximum. `>=` on the left lets a flat-topped two-bin carrier anchor
    // on its left bin (the right `>` keeps it from anchoring twice).
    if (!(here >= left && here > right)) continue;

    // Gate 1 — light level prefilter (cheap; skips the deep noise floor).
    const snr = here - floor[i]!;
    if (!finite(snr) || snr < MIN_SNR_DB) continue;

    // Gate 2 — amplitude stationarity. Voice swings; a carrier is steady.
    const steadiness = steady[i]!;
    if (!finite(steadiness) || steadiness < MIN_STEADINESS) continue;

    // Gate 3 — prominence over the local saddle (carrier vs hump shoulder, and
    // the fix for CFAR self-masking on strong carriers).
    const prominence = saddleProminenceDb(spec, i, windowBins);
    if (prominence < MIN_PROMINENCE_DB) continue;

    // Gate 4 — narrowness. A carrier collapses within a couple of bins; a voice
    // hump stays above the −6 dB line for hundreds of Hz.
    const widthHz = widthAtDropHz(spec, i, here - WIDTH_DROP_DB, hzPerPixel);
    if (widthHz > MAX_CARRIER_WIDTH_HZ) continue;

    const candidate: AutoNotchCandidate = {
      centerHz: binToHz(i, n, centerHz, hzPerPixel),
      widthHz: clampWidth(widthHz + 2 * NOTCH_PAD_HZ),
      snrDb: prominence,
      confidence: steadiness,
    };
    if (!isCoveredByManualNotch(candidate, input.existingNotches ?? [])) {
      raw.push(candidate);
    }
  }

  raw.sort(candidateSort);
  const accepted: AutoNotchCandidate[] = [];
  for (const c of raw) {
    if (accepted.length >= MAX_AUTO_NOTCHES) break;
    if (accepted.some((a) => Math.abs(a.centerHz - c.centerHz) <= MERGE_HZ)) continue;
    accepted.push(c);
  }
  return accepted.sort((a, b) => a.centerHz - b.centerHz);
}
