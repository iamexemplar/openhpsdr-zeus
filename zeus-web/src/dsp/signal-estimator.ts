// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF),
//                         Douglas J. Cerrato (KB2UKA), and contributors.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 2 of the License, or (at your
// option) any later version. See the LICENSE file at the root of this
// repository for the full text, or https://www.gnu.org/licenses/.
//
// Zeus is distributed WITHOUT ANY WARRANTY; see the GNU General Public
// License for details.

// Shared spectrum signal estimator.
//
// One per-bin noise-floor estimate feeds TWO operator features that both need
// to know "where is the noise and where are the signals":
//
//   • Signal Pop  — subtract the per-bin floor before the colormap so weak
//                   carriers leap off a flattened baseline (band tilt removed).
//   • Snap-to     — on click, search the bins near the cursor for the strongest
//                   carrier above the floor and tune exactly onto it.
//
// This is classical DSP, not ML. The floor is estimated SPATIALLY (across
// frequency) — a sliding-window minimum of the spectrum, lifted toward the
// noise mean and lightly smoothed in time. Spatial (CFAR-style) is the right
// model here: a bin's noise is read from its frequency neighbours, so even a
// STEADY carrier pops against the noise around it. A purely temporal per-bin
// tracker would instead converge up to a steady carrier and suppress it. It
// runs on the existing display pixels (panDb), so there is NO backend, native,
// or protocol change — and it is gated entirely off (zero per-frame cost)
// unless the operator turns Pop or Snap on.
//
// All of this is OPT-IN and OFF BY DEFAULT: first-connect behaviour is byte-for
// -byte the current panadapter/waterfall. The Pop dB window and snap tuning are
// display/UX surface — final values are the maintainer's call (CLAUDE.md).

import { create } from 'zustand';

// ── Floor-estimator tuning ──────────────────────────────────────────────────
// Spatial window half-width, in Hz. The sliding minimum is taken over roughly
// ±(window/2) around each bin, so the window must be wider than the widest
// signal we want to pop (an SSB channel ≈ 2.7 kHz) to read the noise beside it.
// Converted to bins per-frame using the live Hz/pixel, then clamped so extreme
// zoom levels stay sane.
const FLOOR_WINDOW_HZ = 6000;
const FLOOR_MIN_RADIUS_BINS = 6;
const FLOOR_MAX_RADIUS_BINS = 160;
// The window minimum sits in the lower tail of the noise; lift it toward the
// noise mean so `raw − floor` centres noise near 0 dB rather than several dB up.
const NOISE_OFFSET_DB = 4;
// Light temporal smoothing of the spatial floor — kills frame-to-frame jitter
// in the minimum without lagging real noise-floor changes. 1.0 on a geometry
// reset so the first frame is already converged (no flat opening frame).
const FLOOR_TIME_EMA = 0.3;

// ── Pop display window (dB above the estimated floor) ───────────────────────
// `enhanced = raw − floor`, then the existing colormap maps [floor, floor+span].
// Defaults pull noise toward the dark end and let carriers a few dB up bloom.
// These want on-air tuning by the maintainer; exposed in the store so a future
// slider can adjust them without a code change.
const DEFAULT_POP_FLOOR_DB = 3;
const DEFAULT_POP_SPAN_DB = 40;

// ── Snap search ─────────────────────────────────────────────────────────────
// Look this far either side of the click for a carrier, and only snap to bins
// at least this many dB above the local floor (else there's nothing to grab).
const SNAP_RADIUS_HZ = 4000;
const SNAP_MIN_SNR_DB = 6;

// ── Peak detection (CFAR-style markers) ─────────────────────────────────────
// A bin is a marked peak when it is a local maximum at least this many dB above
// its spatial floor. A little stricter than the snap threshold so the markers
// flag real carriers, not every noise bump. Near-duplicates inside the spacing
// (skirts of one wide signal) collapse to the strongest; total markers capped.
const PEAK_MIN_SNR_DB = 8;
const PEAK_MIN_SPACING_BINS = 4;
const PEAK_MAX_COUNT = 48;
// SNR at which a marker reaches full opacity (alpha scales 0..1 up to this).
const PEAK_FULL_SNR_DB = 40;

const STORAGE_KEY = 'zeus.enhance';

export type SignalEnhanceState = {
  /** Per-bin noise-floor subtraction on the panadapter + waterfall. */
  popEnabled: boolean;
  /** Snap-to-signal on panadapter/waterfall click. */
  snapEnabled: boolean;
  /** Colormap floor for Pop mode, in dB above the tracked noise floor. */
  popFloorDb: number;
  /** Colormap span for Pop mode, in dB. Window is [popFloorDb, +popSpanDb]. */
  popSpanDb: number;
  setPopEnabled: (v: boolean) => void;
  setSnapEnabled: (v: boolean) => void;
  togglePop: () => void;
  toggleSnap: () => void;
};

function readPersisted(): { popEnabled: boolean; snapEnabled: boolean } {
  try {
    if (typeof localStorage === 'undefined') return { popEnabled: false, snapEnabled: false };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { popEnabled: false, snapEnabled: false };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      popEnabled: parsed.popEnabled === true,
      snapEnabled: parsed.snapEnabled === true,
    };
  } catch {
    return { popEnabled: false, snapEnabled: false };
  }
}

function persist(s: { popEnabled: boolean; snapEnabled: boolean }): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ popEnabled: s.popEnabled, snapEnabled: s.snapEnabled }));
  } catch {
    // quota / private mode — in-memory state is still the source of truth.
  }
}

const persisted = readPersisted();

export const useSignalEnhanceStore = create<SignalEnhanceState>((set, get) => ({
  popEnabled: persisted.popEnabled,
  snapEnabled: persisted.snapEnabled,
  popFloorDb: DEFAULT_POP_FLOOR_DB,
  popSpanDb: DEFAULT_POP_SPAN_DB,
  setPopEnabled: (popEnabled) => {
    set({ popEnabled });
    persist({ popEnabled, snapEnabled: get().snapEnabled });
  },
  setSnapEnabled: (snapEnabled) => {
    set({ snapEnabled });
    persist({ popEnabled: get().popEnabled, snapEnabled });
  },
  togglePop: () => {
    const popEnabled = !get().popEnabled;
    set({ popEnabled });
    persist({ popEnabled, snapEnabled: get().snapEnabled });
  },
  toggleSnap: () => {
    const snapEnabled = !get().snapEnabled;
    set({ snapEnabled });
    persist({ popEnabled: get().popEnabled, snapEnabled });
  },
}));

// ── Per-bin floor estimator (module singleton) ──────────────────────────────
// Singleton, not per-component: the panadapter and waterfall must enhance off
// the SAME floor, and a click handler needs it on demand. Driven once per frame
// from display-store.pushFrame so both surfaces see an already-updated floor.

let floor: Float32Array | null = null; // published, time-smoothed floor
let winMin: Float32Array | null = null; // per-frame spatial window minimum
let dq: Int32Array | null = null; // monotonic-deque index ring for slidingMin
let geomKey = '';

/** A floor estimate is only valid for the geometry it was built on. Width and
 *  Hz/pixel changes (zoom, sample rate) re-scale the window and bin layout, so
 *  re-converge in one frame (EMA=1). A plain retune does NOT reset — the
 *  spatial estimate is frame-local and needs no per-bin history. */
function makeGeomKey(width: number, hzPerPixel: number): string {
  return `${width}:${hzPerPixel}`;
}

type EstimatorFrame = {
  panDb: Float32Array | null;
  panValid: boolean;
  width: number;
  hzPerPixel: number;
};

/** Update the floor estimate for this frame — but only when an operator feature
 *  needs it. When both Pop and Snap are off this returns immediately, so the
 *  feature carries no cost until switched on. Call before notifying subscribers
 *  so the same-frame enhance sees this frame's floor. */
export function maybeUpdateEstimator(f: EstimatorFrame): void {
  const st = useSignalEnhanceStore.getState();
  if (!st.popEnabled && !st.snapEnabled) return;
  if (!f.panValid || !f.panDb || f.panDb.length === 0) return;
  updateFloor(f.panDb, f.hzPerPixel, makeGeomKey(f.width, f.hzPerPixel));
}

/** Sliding-window minimum over ±radius bins, written into `out`. O(n) via a
 *  monotonic-increasing deque of indices (front = current window min). */
function slidingMin(src: Float32Array, radius: number, out: Float32Array): void {
  const n = src.length;
  if (dq === null || dq.length < n) dq = new Int32Array(n);
  const idx = dq;
  let head = 0;
  let tail = 0; // deque occupies [head, tail)
  let j = 0; // next source index not yet pushed
  for (let i = 0; i < n; i++) {
    const right = Math.min(n - 1, i + radius);
    while (j <= right) {
      const v = src[j]!;
      while (tail > head && src[idx[tail - 1]!]! >= v) tail--;
      idx[tail++] = j;
      j++;
    }
    const left = i - radius;
    while (idx[head]! < left) head++;
    out[i] = src[idx[head]!]!;
  }
}

function updateFloor(spec: Float32Array, hzPerPixel: number, key: string): void {
  const n = spec.length;
  const reset = floor === null || floor.length !== n || key !== geomKey;
  if (floor === null || floor.length !== n) floor = new Float32Array(n);
  if (winMin === null || winMin.length !== n) winMin = new Float32Array(n);

  let radius = hzPerPixel > 0 ? Math.round(FLOOR_WINDOW_HZ / hzPerPixel / 2) : FLOOR_MIN_RADIUS_BINS;
  radius = Math.max(FLOOR_MIN_RADIUS_BINS, Math.min(FLOOR_MAX_RADIUS_BINS, radius));
  slidingMin(spec, radius, winMin);

  const f = floor;
  const wm = winMin;
  const a = reset ? 1 : FLOOR_TIME_EMA;
  for (let i = 0; i < n; i++) {
    const target = wm[i]! + NOISE_OFFSET_DB;
    f[i] = reset ? target : f[i]! + a * (target - f[i]!);
  }
  geomKey = key;
}

/** Current per-bin floor, or null before the first frame. Read-only — callers
 *  must not mutate it. */
export function getNoiseFloor(): Float32Array | null {
  return floor;
}

/** Reset the estimator (e.g. on disconnect). Next frame re-seeds. */
export function resetEstimator(): void {
  floor = null;
  winMin = null;
  geomKey = '';
}

/** Per-bin floor subtraction: `out[i] = raw[i] − floor[i]`. Falls back to a
 *  straight copy when no floor exists yet or lengths disagree (geometry just
 *  changed mid-flight). `out` must be the same length as `raw`. */
export function enhanceInto(raw: Float32Array, out: Float32Array): void {
  const n = raw.length;
  const f = floor;
  if (f === null || f.length !== n) {
    out.set(raw);
    return;
  }
  for (let i = 0; i < n; i++) {
    out[i] = raw[i]! - f[i]!;
  }
}

/** Find the strongest carrier near a clicked frequency and return its exact
 *  bin-center frequency, or null if nothing rises far enough above the floor.
 *
 *  Pure: caller supplies the live spectrum + geometry (panadapter store) and we
 *  use the shared floor. Bypasses the 500 Hz tune grid — snap lands on the real
 *  carrier, not the nearest round number. */
export function findPeakHz(
  spec: Float32Array,
  centerHz: number,
  hzPerPixel: number,
  clickHz: number,
): number | null {
  const n = spec.length;
  if (n < 3 || hzPerPixel <= 0) return null;
  const f = floor;
  const half = n / 2;
  const clickBin = Math.round((clickHz - centerHz) / hzPerPixel + half);
  const radius = Math.max(2, Math.round(SNAP_RADIUS_HZ / hzPerPixel));
  const lo = Math.max(1, clickBin - radius);
  const hi = Math.min(n - 2, clickBin + radius);
  let bestBin = -1;
  let bestVal = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = spec[i]!;
    const fl = f && f.length === n ? f[i]! : -200;
    if (v < fl + SNAP_MIN_SNR_DB) continue;
    // Local maximum so we land on the carrier crest, not its skirt.
    if (v >= spec[i - 1]! && v >= spec[i + 1]! && v > bestVal) {
      bestVal = v;
      bestBin = i;
    }
  }
  if (bestBin < 0) return null;
  return centerHz + (bestBin - half) * hzPerPixel;
}

export type DetectedPeak = {
  /** Absolute bin-centre frequency of the peak. */
  hz: number;
  /** dB above the local noise floor (used for marker opacity). */
  snrDb: number;
};

/** Detect carriers across the whole span for the snap-target markers. Returns
 *  local maxima at least PEAK_MIN_SNR_DB above their spatial floor, de-duplicated
 *  to the strongest within PEAK_MIN_SPACING_BINS and capped at PEAK_MAX_COUNT
 *  (strongest first). Empty until a floor exists. Pure: caller passes the live
 *  spectrum + geometry. */
export function detectPeaks(spec: Float32Array, centerHz: number, hzPerPixel: number): DetectedPeak[] {
  const n = spec.length;
  const f = floor;
  if (n < 3 || hzPerPixel <= 0 || f === null || f.length !== n) return [];
  const half = n / 2;
  const found: Array<{ bin: number; snrDb: number }> = [];
  for (let i = 1; i < n - 1; i++) {
    const v = spec[i]!;
    const snr = v - f[i]!;
    if (snr < PEAK_MIN_SNR_DB) continue;
    // `>=` left / `>` right accepts a flat top once (at its right edge) rather
    // than emitting a marker for every bin of the plateau.
    if (v >= spec[i - 1]! && v > spec[i + 1]!) {
      found.push({ bin: i, snrDb: snr });
    }
  }
  // Strongest first, then greedily accept peaks that clear the spacing — so the
  // skirts of one wide signal collapse onto its crest.
  found.sort((a, b) => b.snrDb - a.snrDb);
  const accepted: Array<{ bin: number; snrDb: number }> = [];
  for (const p of found) {
    if (accepted.length >= PEAK_MAX_COUNT) break;
    let clear = true;
    for (const q of accepted) {
      if (Math.abs(q.bin - p.bin) < PEAK_MIN_SPACING_BINS) {
        clear = false;
        break;
      }
    }
    if (clear) accepted.push(p);
  }
  return accepted.map((p) => ({ hz: centerHz + (p.bin - half) * hzPerPixel, snrDb: p.snrDb }));
}

/** Normalised marker opacity (0..1) for a peak SNR, for the amber tick alpha. */
export function peakAlpha(snrDb: number): number {
  return Math.max(0.25, Math.min(1, snrDb / PEAK_FULL_SNR_DB));
}
