// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

import { create } from 'zustand';

export type CwDecoderState = 'idle' | 'listening' | 'held';

export type CwThresholdMode = 'auto' | 'manual';

export type CwDecoderStore = {
  state: CwDecoderState;
  // Continuous decoded stream. CW has no line structure (no carriage
  // returns), so this is one flowing buffer the panel scrolls — not a list of
  // per-word lines. Capped to the last `maxChars` so it can't grow unbounded.
  text: string;
  maxChars: number;
  wpm: number;
  snrDb: number;
  confidence: number;

  // Real-time envelope telemetry from CwDecodedTextFrame (zeus-yrq Phase 2).
  // Values are in dBFS (typically -100..0). Updated on every DSP tick (~48 Hz)
  // via pushEnvelope() regardless of decoder state, so the scope is always live.
  envelopeDb: number;
  noiseFloorDb: number;

  // Threshold scope.
  // 'auto'   = adaptive Schmitt trigger (server default).
  // 'manual' = operator-pinned; thresholdDb is in dBFS (sent to backend via
  //            PUT /api/cw/decoder/settings). thresholdFraction is the
  //            normalised 0..1 position on the scope canvas (for drag UI).
  thresholdMode: CwThresholdMode;
  thresholdDb: number;      // dBFS value sent to/from server
  thresholdFraction: number; // 0..1 display position (derived from thresholdDb + scope range)

  // Actions
  setEnabled: (enabled: boolean) => void;
  toggleHold: () => void;
  clear: () => void;
  appendText: (chunk: string, wpm: number, snrDb: number, confidence: number) => void;
  updateStats: (wpm: number, snrDb: number, confidence: number) => void;
  pushEnvelope: (envelopeDb: number, noiseFloorDb: number, snrDb: number, confidence: number, wpm: number) => void;
  setThreshold: (fraction: number) => void;   // drag UI → computes dBFs + PUTs to server
  resetThreshold: () => void;                 // → auto mode, PUTs to server
};

const MAX_CHARS = 4000;

// dBFS range displayed on the scope canvas — maps linearly to Y position.
const SCOPE_DB_MIN = -80;
const SCOPE_DB_MAX = -20;

function dbToFraction(db: number): number {
  return Math.max(0, Math.min(1, (db - SCOPE_DB_MIN) / (SCOPE_DB_MAX - SCOPE_DB_MIN)));
}

function fractionToDb(f: number): number {
  return SCOPE_DB_MIN + f * (SCOPE_DB_MAX - SCOPE_DB_MIN);
}

async function putThreshold(isManual: boolean, thresholdDb?: number): Promise<void> {
  try {
    await fetch('/api/cw/decoder/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isManual, thresholdDb }),
    });
  } catch { /* non-critical — scope still works visually */ }
}

export const useCwDecoderStore = create<CwDecoderStore>((set) => ({
  state: 'idle',
  text: '',
  maxChars: MAX_CHARS,
  wpm: 0,
  snrDb: 0,
  confidence: 0,
  envelopeDb: -80,
  noiseFloorDb: -80,
  thresholdMode: 'auto',
  thresholdDb: -50,
  thresholdFraction: dbToFraction(-50),

  setEnabled: (enabled) =>
    set((s) => ({
      state: s.state === 'held' && enabled ? 'held' : enabled ? 'listening' : 'idle',
    })),

  toggleHold: () =>
    set((s) => ({
      state: s.state === 'listening' ? 'held' : s.state === 'held' ? 'listening' : s.state,
    })),

  clear: () =>
    set({
      text: '',
      wpm: 0,
      snrDb: 0,
      confidence: 0,
    }),

  appendText: (chunk, wpm, snrDb, confidence) =>
    set((s) => ({
      text: (s.text + chunk).slice(-s.maxChars),
      wpm,
      snrDb,
      confidence,
    })),

  updateStats: (wpm, snrDb, confidence) =>
    set({ wpm, snrDb, confidence }),

  pushEnvelope: (envelopeDb, noiseFloorDb, snrDb, confidence, wpm) =>
    set({ envelopeDb, noiseFloorDb, snrDb, confidence, wpm }),

  setThreshold: (fraction) => {
    const db = fractionToDb(Math.max(0, Math.min(1, fraction)));
    set({ thresholdMode: 'manual', thresholdDb: db, thresholdFraction: fraction });
    void putThreshold(true, db);
  },

  resetThreshold: () => {
    set({ thresholdMode: 'auto', thresholdDb: -50, thresholdFraction: dbToFraction(-50) });
    void putThreshold(false);
  },
}));

export { dbToFraction, fractionToDb, SCOPE_DB_MIN, SCOPE_DB_MAX };
