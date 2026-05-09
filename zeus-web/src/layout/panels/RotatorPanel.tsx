// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
//
// RotatorPanel — workspace tile that hosts the CompassDial + a single
// horizontal control strip (manual az input, GO, STOP, N/E/S/W presets).
// All state lives in `useRotatorStore`; this panel adds no new API calls.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CompassDial } from '../../components/rotator/CompassDial';
import { useRotatorStore } from '../../state/rotator-store';

function normalizeAz(az: number | null | undefined): number | null {
  if (az == null || !Number.isFinite(az)) return null;
  return ((az % 360) + 360) % 360;
}

function formatAz(az: number | null | undefined): string {
  const n = normalizeAz(az);
  if (n == null) return '—';
  return `${n.toFixed(0).padStart(3, '0')}°`;
}

const PRESETS: ReadonlyArray<{ label: string; az: number }> = [
  { label: 'N', az: 0 },
  { label: 'E', az: 90 },
  { label: 'S', az: 180 },
  { label: 'W', az: 270 },
];

export function RotatorPanel() {
  const status = useRotatorStore((s) => s.status);
  const setAzimuth = useRotatorStore((s) => s.setAzimuth);
  const stop = useRotatorStore((s) => s.stop);

  const connected = !!status?.connected;
  const moving = !!status?.moving;
  const currentAz = normalizeAz(status?.currentAz);
  const targetAz = normalizeAz(status?.targetAz);

  const [manual, setManual] = useState<string>('');

  const dialContainerRef = useRef<HTMLDivElement | null>(null);
  const [dialSize, setDialSize] = useState<number>(220);

  // ResizeObserver: pick the largest square that fits the dial slot.
  useEffect(() => {
    const el = dialContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        const next = Math.max(80, Math.floor(Math.min(w, h)));
        setDialSize(next);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function commitManual() {
    const n = Number(manual);
    if (!Number.isFinite(n)) return;
    const az = ((Math.round(n) % 360) + 360) % 360;
    void setAzimuth(az);
    setManual('');
  }

  const statusLine = useMemo(() => {
    if (!connected) return '—';
    return `${formatAz(currentAz)} → ${formatAz(targetAz ?? currentAz)}`;
  }, [connected, currentAz, targetAz]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 8,
        overflow: 'hidden',
        minHeight: 0,
      }}
    >
      <div
        ref={dialContainerRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CompassDial
          currentAz={currentAz}
          targetAz={targetAz}
          size={dialSize}
          disabled={!connected}
          onCommit={(az) => {
            void setAzimuth(az);
          }}
        />
      </div>

      <div
        data-testid="rotator-status-line"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'center',
          gap: 8,
          fontSize: 13,
          fontFamily: 'var(--font-mono)',
          color: 'var(--fg-2)',
        }}
      >
        {connected ? (
          <>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{formatAz(currentAz)}</span>
            <span style={{ color: 'var(--fg-3)' }}>→</span>
            <span style={{ color: 'var(--power)', fontWeight: 700 }}>
              {targetAz == null ? formatAz(currentAz) : formatAz(targetAz)}
            </span>
            {moving && (
              <span
                data-testid="rotator-moving-badge"
                style={{
                  marginLeft: 8,
                  padding: '1px 6px',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--power)',
                  background: 'rgba(255,201,58,0.12)',
                  border: '1px solid var(--power)',
                  borderRadius: 'var(--r-sm)',
                }}
              >
                moving
              </span>
            )}
          </>
        ) : (
          <span>{statusLine}</span>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <input
          data-testid="rotator-manual-input"
          type="number"
          min={0}
          max={359}
          step={1}
          placeholder="az°"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitManual();
            }
          }}
          disabled={!connected}
          style={{
            width: 64,
            padding: '4px 6px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-0)',
            color: 'var(--fg-0)',
            border: '1px solid var(--panel-border)',
            borderRadius: 'var(--r-sm)',
            textAlign: 'right',
          }}
        />
        <button
          type="button"
          data-testid="rotator-go"
          onClick={commitManual}
          disabled={!connected || manual === ''}
          className="btn sm"
        >
          GO
        </button>
        <button
          type="button"
          data-testid="rotator-stop"
          onClick={() => void stop()}
          disabled={!connected}
          className="btn sm"
          style={{
            borderColor: 'var(--tx)',
            color: 'var(--tx)',
          }}
        >
          STOP
        </button>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 1,
            height: 18,
            background: 'var(--panel-border)',
            margin: '0 4px',
          }}
        />
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            data-testid={`rotator-preset-${p.label}`}
            onClick={() => void setAzimuth(p.az)}
            disabled={!connected}
            className="btn sm"
            title={`Slew to ${p.az}°`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
