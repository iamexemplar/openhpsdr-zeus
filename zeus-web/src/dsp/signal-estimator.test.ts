// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF),
//                         Douglas J. Cerrato (KB2UKA), and contributors.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License v2 or later. See the
// LICENSE file at the repository root, or https://www.gnu.org/licenses/.

import { afterEach, describe, expect, it } from 'vitest';
import {
  detectPeaks,
  enhanceInto,
  findPeakHz,
  getNoiseFloor,
  maybeUpdateEstimator,
  peakAlpha,
  resetEstimator,
  useSignalEnhanceStore,
} from './signal-estimator';

const WIDTH = 256;
const HZ_PER_PX = 100;
const CENTER = 14_200_000;
const NOISE_DB = -110;
const CARRIER_BIN = 150;
const CARRIER_DB = -50;

// Flat noise floor with a single one-bin carrier spike at CARRIER_BIN.
function spectrumWithCarrier(): Float32Array {
  const spec = new Float32Array(WIDTH).fill(NOISE_DB);
  spec[CARRIER_BIN] = CARRIER_DB;
  return spec;
}

// Sloped (band-tilt) noise floor: -90 at the left edge down to -120 at the
// right, plus the same carrier spike.
function spectrumWithTilt(): Float32Array {
  const spec = new Float32Array(WIDTH);
  for (let i = 0; i < WIDTH; i++) spec[i] = -90 + (-30 * i) / WIDTH;
  spec[CARRIER_BIN] = CARRIER_DB;
  return spec;
}

function pushFrame(spec: Float32Array): void {
  maybeUpdateEstimator({ panDb: spec, panValid: true, width: WIDTH, hzPerPixel: HZ_PER_PX });
}

afterEach(() => {
  resetEstimator();
  useSignalEnhanceStore.setState({ popEnabled: false, snapEnabled: false });
});

describe('signal estimator — spatial floor', () => {
  it('stays cold (no floor, zero cost) when both Pop and Snap are off', () => {
    pushFrame(spectrumWithCarrier());
    expect(getNoiseFloor()).toBeNull();
  });

  it('estimates the floor from neighbours — a steady carrier does NOT raise its own floor', () => {
    useSignalEnhanceStore.setState({ popEnabled: true });
    // Many identical frames: a temporal tracker would creep the carrier bin's
    // floor up to the carrier. The spatial estimate must keep it at the noise.
    for (let k = 0; k < 30; k++) pushFrame(spectrumWithCarrier());
    const floor = getNoiseFloor()!;
    expect(floor).not.toBeNull();
    // Floor at the carrier bin tracks the surrounding noise (+ a few dB offset),
    // nowhere near the −50 dB carrier.
    expect(floor[CARRIER_BIN]!).toBeLessThan(NOISE_DB + 12);
    expect(floor[CARRIER_BIN]!).toBeGreaterThan(NOISE_DB - 2);
  });

  it('pops the carrier far above the enhanced noise', () => {
    useSignalEnhanceStore.setState({ popEnabled: true });
    for (let k = 0; k < 5; k++) pushFrame(spectrumWithCarrier());
    const spec = spectrumWithCarrier();
    const out = new Float32Array(WIDTH);
    enhanceInto(spec, out);
    // Carrier rises ~ (carrier − noise) above the floor; noise sits near 0.
    expect(out[CARRIER_BIN]!).toBeGreaterThan(45);
    expect(Math.abs(out[0]!)).toBeLessThan(8);
    expect(out[CARRIER_BIN]! - out[0]!).toBeGreaterThan(40);
  });

  it('flattens band tilt — enhanced noise is roughly level across the span', () => {
    useSignalEnhanceStore.setState({ popEnabled: true });
    for (let k = 0; k < 5; k++) pushFrame(spectrumWithTilt());
    const spec = spectrumWithTilt();
    const out = new Float32Array(WIDTH);
    enhanceInto(spec, out);
    // Left edge (−90) and right edge (−120) differ by 30 dB raw; after
    // floor subtraction they should land within a few dB of each other.
    expect(Math.abs(out[5]! - out[WIDTH - 5]!)).toBeLessThan(8);
  });

  it('enhanceInto falls back to a copy before any floor exists', () => {
    const spec = spectrumWithCarrier();
    const out = new Float32Array(WIDTH);
    enhanceInto(spec, out); // no floor yet
    expect(Array.from(out)).toEqual(Array.from(spec));
  });
});

describe('signal estimator — snap-to-signal', () => {
  it('snaps a near-carrier click onto the exact carrier bin frequency', () => {
    useSignalEnhanceStore.setState({ popEnabled: true });
    for (let k = 0; k < 5; k++) pushFrame(spectrumWithCarrier());
    const spec = spectrumWithCarrier();
    // Click 1.8 kHz away from the carrier (carrier is at +2200 Hz from center).
    const clickHz = CENTER + 2000;
    const peak = findPeakHz(spec, CENTER, HZ_PER_PX, clickHz);
    const carrierHz = CENTER + (CARRIER_BIN - WIDTH / 2) * HZ_PER_PX;
    expect(peak).toBe(carrierHz);
  });

  it('returns null over bare noise (nothing rises above the floor)', () => {
    useSignalEnhanceStore.setState({ popEnabled: true });
    for (let k = 0; k < 5; k++) pushFrame(spectrumWithCarrier());
    const spec = spectrumWithCarrier();
    // Click far from the carrier, on flat noise.
    const peak = findPeakHz(spec, CENTER, HZ_PER_PX, CENTER - 5000);
    expect(peak).toBeNull();
  });
});

describe('signal estimator — peak markers (CFAR)', () => {
  it('detects the carrier and nothing else on a flat-noise span', () => {
    useSignalEnhanceStore.setState({ snapEnabled: true });
    for (let k = 0; k < 5; k++) pushFrame(spectrumWithCarrier());
    const peaks = detectPeaks(spectrumWithCarrier(), CENTER, HZ_PER_PX);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.hz).toBe(CENTER + (CARRIER_BIN - WIDTH / 2) * HZ_PER_PX);
    expect(peaks[0]!.snrDb).toBeGreaterThan(45);
  });

  it('collapses a multi-bin signal to a single strongest marker', () => {
    useSignalEnhanceStore.setState({ snapEnabled: true });
    const spec = new Float32Array(WIDTH).fill(NOISE_DB);
    // A 3-bin-wide signal cresting at the middle bin.
    spec[120] = -70;
    spec[121] = -55;
    spec[122] = -68;
    for (let k = 0; k < 5; k++) pushFrame(spec);
    const peaks = detectPeaks(spec, CENTER, HZ_PER_PX);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.hz).toBe(CENTER + (121 - WIDTH / 2) * HZ_PER_PX);
  });

  it('returns nothing before a floor exists', () => {
    expect(detectPeaks(spectrumWithCarrier(), CENTER, HZ_PER_PX)).toEqual([]);
  });

  it('peakAlpha scales with SNR and stays within [0.25, 1]', () => {
    expect(peakAlpha(0)).toBe(0.25);
    expect(peakAlpha(1000)).toBe(1);
    expect(peakAlpha(20)).toBeGreaterThan(0.25);
    expect(peakAlpha(20)).toBeLessThan(1);
  });
});
