// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

import { useEffect, useRef, useCallback } from 'react';
import {
  useCwDecoderStore,
  SCOPE_DB_MIN,
  SCOPE_DB_MAX,
} from '../../state/cw-decoder-store';

const SCOPE_SAMPLES = 200;
const LABEL_W = 28;  // px reserved for dB axis labels

function dbToY(db: number, h: number): number {
  const clamped = Math.max(SCOPE_DB_MIN, Math.min(SCOPE_DB_MAX, db));
  const frac = (clamped - SCOPE_DB_MIN) / (SCOPE_DB_MAX - SCOPE_DB_MIN);
  return h - frac * h;
}

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function CwThresholdScope() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const envelopeDb   = useCwDecoderStore((s) => s.envelopeDb);
  const noiseFloorDb = useCwDecoderStore((s) => s.noiseFloorDb);
  const thresholdMode = useCwDecoderStore((s) => s.thresholdMode);
  const thresholdDb   = useCwDecoderStore((s) => s.thresholdDb);
  const setThreshold  = useCwDecoderStore((s) => s.setThreshold);
  const resetThreshold = useCwDecoderStore((s) => s.resetThreshold);

  // Ring buffer: real envelope samples from CwDecodedTextFrame
  const ringBuf  = useRef<Float32Array>(new Float32Array(SCOPE_SAMPLES));
  const ringHead = useRef(0);

  // Push real envelope sample every time the store updates
  useEffect(() => {
    ringBuf.current[ringHead.current % SCOPE_SAMPLES] = envelopeDb;
    ringHead.current++;
  }, [envelopeDb]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    const colBg      = token('--bg-meter',     '#050507');
    const colLabel   = token('--fg-3',         '#5a5a60');
    const colGrid    = token('--line-strong',  '#2c2c32');
    const colSignal  = token('--accent-bright','#4ea6ff');
    const colFill    = 'rgba(78,166,255,0.18)';
    const colThresh  = token('--power',        '#ffb13c');
    const colNoise   = token('--ok',           '#2dd566');
    const colMono    = token('--font-mono',    'monospace');

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colBg;
    ctx.fillRect(0, 0, w, h);

    const plotW = w - LABEL_W;

    // Grid lines + dB labels at 10 dB intervals
    ctx.font = `500 8px ${colMono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const step = 10;
    for (let db = SCOPE_DB_MIN; db <= SCOPE_DB_MAX; db += step) {
      const y = dbToY(db, h);
      ctx.strokeStyle = colGrid;
      ctx.lineWidth = db === SCOPE_DB_MIN ? 1 : 0.5;
      ctx.setLineDash(db === SCOPE_DB_MIN ? [] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(LABEL_W, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colLabel;
      ctx.fillText(`${db}`, LABEL_W - 3, y);
    }

    // Noise floor band — shade the region below the tracked noise floor
    const nfY = dbToY(noiseFloorDb, h);
    ctx.fillStyle = `${colNoise}18`;
    ctx.fillRect(LABEL_W, nfY, plotW, h - nfY);

    // Noise floor line
    ctx.strokeStyle = colNoise;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, nfY);
    ctx.lineTo(w, nfY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform (real envelope samples)
    const total = Math.min(ringHead.current, SCOPE_SAMPLES);
    if (total > 1) {
      const start  = ringHead.current - total;
      const xStep  = plotW / SCOPE_SAMPLES;

      // Fill under curve
      ctx.beginPath();
      for (let i = 0; i < total; i++) {
        const idx = (start + i) % SCOPE_SAMPLES;
        const x = LABEL_W + i * xStep;
        const y = dbToY(ringBuf.current[idx] ?? SCOPE_DB_MIN, h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(LABEL_W + (total - 1) * xStep, h);
      ctx.lineTo(LABEL_W, h);
      ctx.closePath();
      ctx.fillStyle = colFill;
      ctx.fill();

      // Envelope line
      ctx.beginPath();
      for (let i = 0; i < total; i++) {
        const idx = (start + i) % SCOPE_SAMPLES;
        const x = LABEL_W + i * xStep;
        const y = dbToY(ringBuf.current[idx] ?? SCOPE_DB_MIN, h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = colSignal;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Threshold line — position from store
    const thrDb = thresholdMode === 'manual'
      ? thresholdDb
      : noiseFloorDb + 6; // auto: 6 dB above tracked noise floor as visual hint
    const thrY = dbToY(thrDb, h);

    ctx.strokeStyle = colThresh;
    ctx.lineWidth = thresholdMode === 'manual' ? 2 : 1.5;
    ctx.setLineDash(thresholdMode === 'manual' ? [] : [5, 3]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, thrY);
    ctx.lineTo(w, thrY);
    ctx.stroke();
    ctx.setLineDash([]);

    // "THR" label
    ctx.fillStyle = colThresh;
    ctx.font = `600 8px ${colMono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('THR', w - 2, thrY - 2);

    // Left axis border
    ctx.strokeStyle = colGrid;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, 0);
    ctx.lineTo(LABEL_W, h);
    ctx.stroke();

    rafRef.current = requestAnimationFrame(draw);
  }, [envelopeDb, noiseFloorDb, thresholdMode, thresholdDb]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // Resize canvas to CSS size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) {
          canvas.width = Math.round(width);
          canvas.height = Math.round(height);
        }
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Drag threshold
  const isDragging = useRef(false);

  const posToFraction = useCallback((clientY: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    isDragging.current = true;
    setThreshold(posToFraction(e.clientY));
  }, [posToFraction, setThreshold]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current) return;
    setThreshold(posToFraction(e.clientY));
  }, [posToFraction, setThreshold]);

  const stopDrag = useCallback(() => { isDragging.current = false; }, []);

  return (
    <div className="cw-scope">
      <canvas
        ref={canvasRef}
        className={`cw-scope-canvas${thresholdMode === 'manual' ? ' is-manual' : ''}`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
        title="Drag to set decoder threshold — pin just above the noise floor (green) to stop WPM jitter"
        aria-label="CW envelope scope"
      />
      <div className="cw-scope-controls">
        <div className="cw-scope-mode-pill">
          <span
            className="cw-scope-mode-dot"
            style={{ background: thresholdMode === 'auto' ? 'var(--fg-3)' : 'var(--accent-bright)' }}
          />
          <span>{thresholdMode === 'auto' ? 'AUTO' : 'MANUAL'}</span>
        </div>
        {thresholdMode === 'manual' && (
          <>
            <span className="cw-scope-thr-readout mono">THR {thresholdDb.toFixed(1)} dBFS</span>
            <button type="button" className="cw-scope-reset" onClick={resetThreshold} title="Return to adaptive">
              RESET
            </button>
          </>
        )}
        {thresholdMode === 'auto' && (
          <span className="cw-scope-hint">drag THR line to pin above noise (green)</span>
        )}
        <span style={{ flex: 1 }} />
        <span className="cw-scope-thr-readout mono" style={{ color: 'var(--fg-3)' }}>
          NF {noiseFloorDb.toFixed(1)} dB
        </span>
      </div>
    </div>
  );
}
