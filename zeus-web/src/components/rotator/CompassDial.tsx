// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
//
// CompassDial — pure-presentational SVG compass rose used by the Rotator
// panel. Renders an HL2-faithful gradient ring, cardinal markers, a current-
// heading needle (var(--accent)), and an optional target marker
// (var(--power)). Drag/click anywhere inside the dial to commit a target
// azimuth via onCommit. State + rotctld wiring live in the parent panel.

import { useCallback, useRef, useState } from 'react';

export type CompassDialProps = {
  /** Current rotor heading in degrees (0..359, North=0, East=90). null hides the needle. */
  currentAz: number | null;
  /** Target heading in degrees. null hides the marker. Hidden when equal to currentAz. */
  targetAz: number | null;
  /** Optional beam-width wedge centred on currentAz, in degrees. Defaults to undefined (no wedge). */
  beamWidthDeg?: number;
  /** Pixel size of the rendered square. Defaults to 240. */
  size?: number;
  /** Fired with a normalised 0..359 azimuth on click or pointerup-after-drag. */
  onCommit?: (azDeg: number) => void;
  /** When true the dial is dimmed and ignores pointer input. */
  disabled?: boolean;
};

const VIEW = 200;
const CENTER = VIEW / 2;
const R_RING = 90;          // outer ring radius
const R_INNER = 70;          // inner edge of the bevel
const R_NEEDLE = 78;         // length of the needle from centre
const R_TICK_OUT = R_RING;   // ticks live just inside the ring
const R_CARDINAL = 58;       // radius for the cardinal letters

/** Convert (dx, dy) measured from centre into a 0..359 bearing,
 *  N=up=0°, E=right=90°. dy uses screen coordinates (y grows downwards). */
function bearingFromDelta(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Build an SVG path for a wedge centred on `az` with total width `w` degrees. */
function wedgePath(az: number, w: number): string {
  const half = Math.max(0, Math.min(180, w / 2));
  const start = az - half;
  const end = az + half;
  // Convert bearing → screen radians (N=up). 0° bearing → angle = -90° from +x axis.
  const a1 = ((start - 90) * Math.PI) / 180;
  const a2 = ((end - 90) * Math.PI) / 180;
  const x1 = CENTER + R_NEEDLE * Math.cos(a1);
  const y1 = CENTER + R_NEEDLE * Math.sin(a1);
  const x2 = CENTER + R_NEEDLE * Math.cos(a2);
  const y2 = CENTER + R_NEEDLE * Math.sin(a2);
  const large = w > 180 ? 1 : 0;
  return `M ${CENTER} ${CENTER} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R_NEEDLE} ${R_NEEDLE} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

export function CompassDial(props: CompassDialProps) {
  const {
    currentAz,
    targetAz,
    beamWidthDeg,
    size = 240,
    onCommit,
    disabled = false,
  } = props;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef<boolean>(false);
  const [ghostAz, setGhostAz] = useState<number | null>(null);

  const computeAz = useCallback((clientX: number, clientY: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return bearingFromDelta(clientX - cx, clientY - cy);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (disabled) return;
      e.stopPropagation();
      // Capture pointer so move/up keep firing on this element even if the
      // pointer leaves the SVG bounds during a drag.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* not all browsers/jsdom support setPointerCapture; harmless. */
      }
      draggingRef.current = true;
      const az = computeAz(e.clientX, e.clientY);
      if (az != null) setGhostAz(az);
    },
    [computeAz, disabled],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (disabled) return;
      if (!draggingRef.current) return;
      e.stopPropagation();
      const az = computeAz(e.clientX, e.clientY);
      if (az != null) setGhostAz(az);
    },
    [computeAz, disabled],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (disabled) return;
      e.stopPropagation();
      const wasDragging = draggingRef.current;
      draggingRef.current = false;
      setGhostAz(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (!onCommit) return;
      // Always commit pointerup as the canonical click — covers both pure
      // taps and drag-then-release. wasDragging is kept for symmetry/debug.
      void wasDragging;
      const az = computeAz(e.clientX, e.clientY);
      if (az != null) onCommit(Math.round(az) % 360);
    },
    [computeAz, disabled, onCommit],
  );

  const onPointerCancel = useCallback(() => {
    draggingRef.current = false;
    setGhostAz(null);
  }, []);

  // ---- tick generation ---------------------------------------------------
  const ticks: Array<{ deg: number; len: number; weight: number }> = [];
  for (let deg = 0; deg < 360; deg += 5) {
    if (deg % 30 === 0) ticks.push({ deg, len: 12, weight: 1.6 });
    else if (deg % 10 === 0) ticks.push({ deg, len: 8, weight: 1.0 });
    else ticks.push({ deg, len: 4, weight: 0.6 });
  }

  // Show target marker only when distinct from currentAz.
  const showTarget =
    targetAz != null &&
    Number.isFinite(targetAz) &&
    (currentAz == null || Math.abs(((targetAz - currentAz) % 360 + 540) % 360 - 180) > 0.5);

  const gradientId = 'compass-bg-grad';

  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label="Compass dial"
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      style={{
        display: 'block',
        touchAction: 'none',
        userSelect: 'none',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'crosshair',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--panel-top)" />
          <stop offset="100%" stopColor="var(--panel-bot)" />
        </linearGradient>
      </defs>

      {/* face */}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={R_RING}
        fill={`url(#${gradientId})`}
        stroke="var(--panel-border)"
        strokeWidth={1.5}
      />
      <circle
        cx={CENTER}
        cy={CENTER}
        r={R_INNER}
        fill="none"
        stroke="var(--panel-border)"
        strokeOpacity={0.6}
        strokeWidth={0.8}
      />

      {/* optional beam-width wedge (rendered behind ticks/needle) */}
      {currentAz != null && Number.isFinite(currentAz) && beamWidthDeg != null && beamWidthDeg > 0 && (
        <path
          d={wedgePath(currentAz, beamWidthDeg)}
          fill="var(--accent)"
          fillOpacity={0.15}
          stroke="none"
        />
      )}

      {/* tick marks */}
      <g>
        {ticks.map((t) => {
          const a = ((t.deg - 90) * Math.PI) / 180;
          const x1 = CENTER + (R_TICK_OUT - t.len) * Math.cos(a);
          const y1 = CENTER + (R_TICK_OUT - t.len) * Math.sin(a);
          const x2 = CENTER + R_TICK_OUT * Math.cos(a);
          const y2 = CENTER + R_TICK_OUT * Math.sin(a);
          return (
            <line
              key={t.deg}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--fg-2)"
              strokeOpacity={0.85}
              strokeWidth={t.weight}
              strokeLinecap="butt"
            />
          );
        })}
      </g>

      {/* cardinals */}
      <text
        x={CENTER}
        y={CENTER - R_CARDINAL}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="var(--font-display)"
        fontSize={18}
        fontWeight={700}
        fill="var(--fg-0)"
      >
        N
      </text>
      <text
        x={CENTER + R_CARDINAL}
        y={CENTER}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="var(--font-display)"
        fontSize={13}
        fontWeight={600}
        fill="var(--fg-1)"
      >
        E
      </text>
      <text
        x={CENTER}
        y={CENTER + R_CARDINAL}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="var(--font-display)"
        fontSize={13}
        fontWeight={600}
        fill="var(--fg-1)"
      >
        S
      </text>
      <text
        x={CENTER - R_CARDINAL}
        y={CENTER}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="var(--font-display)"
        fontSize={13}
        fontWeight={600}
        fill="var(--fg-1)"
      >
        W
      </text>

      {/* target marker — small inward-pointing triangle on the ring */}
      {showTarget && targetAz != null && (
        <g
          transform={`rotate(${targetAz} ${CENTER} ${CENTER})`}
          style={{ transition: 'transform 600ms var(--ease-out, cubic-bezier(.22,.61,.36,1))' }}
          data-testid="compass-target-marker"
        >
          <polygon
            points={`${CENTER},${CENTER - R_RING + 6} ${CENTER - 6},${CENTER - R_RING - 4} ${CENTER + 6},${CENTER - R_RING - 4}`}
            fill="none"
            stroke="var(--power)"
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        </g>
      )}

      {/* current-heading needle */}
      {currentAz != null && Number.isFinite(currentAz) && (
        <g
          transform={`rotate(${currentAz} ${CENTER} ${CENTER})`}
          style={{ transition: 'transform 600ms var(--ease-out, cubic-bezier(.22,.61,.36,1))' }}
          data-testid="compass-needle"
        >
          <line
            x1={CENTER}
            y1={CENTER}
            x2={CENTER}
            y2={CENTER - R_NEEDLE}
            stroke="var(--accent)"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          {/* tail counterweight */}
          <line
            x1={CENTER}
            y1={CENTER}
            x2={CENTER}
            y2={CENTER + R_NEEDLE * 0.32}
            stroke="var(--accent)"
            strokeOpacity={0.45}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </g>
      )}

      {/* drag-ghost needle */}
      {ghostAz != null && (
        <g transform={`rotate(${ghostAz} ${CENTER} ${CENTER})`} data-testid="compass-ghost">
          <line
            x1={CENTER}
            y1={CENTER}
            x2={CENTER}
            y2={CENTER - R_NEEDLE}
            stroke="var(--fg-2)"
            strokeWidth={1.6}
            strokeDasharray="3 3"
            strokeLinecap="round"
          />
        </g>
      )}

      {/* hub */}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={5}
        fill="var(--bg-0)"
        stroke="var(--fg-2)"
        strokeWidth={1.2}
      />
    </svg>
  );
}
