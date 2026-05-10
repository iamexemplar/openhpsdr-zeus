// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF),
//                         Douglas J. Cerrato (KB2UKA), and contributors.
//
// RF2K-S amplifier panel — operator console for the RF-Kit RF2K-S that
// replaces the dependency on the amp's VNC-viewer for Tune, Bypass,
// Standby/Operate, antenna selection, fault reset, and the live
// forward-power / SWR readouts. Backend talks to the amp's REST API on
// :8080 for everything except Tune and Bypass, which require a VNC
// PointerEvent click (the only mechanical path the firmware allows for
// those two front-panel actions — see Rf2kVncClient.cs preamble).
//
// Visual lift-and-shift of the Amplifier.html design (hero arcs,
// status-chip strip, state row, antenna picker, settings drawer)
// rendered against Zeus's immersive TX-Stage-Meters palette
// (`--immersive-*` tokens) so the amp panel sits next to the TX
// Stage Meters tile without a colour clash. Hero arcs reuse the
// shared `BigArc` component (mode='watts' + mode='swr').

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { GripVertical, Settings, X } from 'lucide-react';
import { useRf2kStore } from '../../state/rf2k-store';
import type { Rf2kAntenna, Rf2kConfig } from '../../api/rf2k';
import { BigArc } from '../../components/immersive-meters/BigArc';

type InterfaceMode = 'UNIV' | 'CAT' | 'UDP' | 'TCI';
const INTERFACE_MODES: InterfaceMode[] = ['UNIV', 'CAT', 'UDP', 'TCI'];

export function Rf2kPanel({ onRemove }: { onRemove?: () => void } = {}) {
  const config = useRf2kStore((s) => s.config);
  const status = useRf2kStore((s) => s.status);
  const configLoaded = useRf2kStore((s) => s.configLoaded);
  const lastClickResult = useRf2kStore((s) => s.lastClickResult);
  const setOperate = useRf2kStore((s) => s.setOperate);
  const setAntenna = useRf2kStore((s) => s.setAntenna);
  const reset = useRf2kStore((s) => s.reset);
  const tune = useRf2kStore((s) => s.tune);
  const bypass = useRf2kStore((s) => s.bypass);

  const [showSettings, setShowSettings] = useState(false);
  const [tuning, setTuning] = useState(false);

  const connected = !!status?.connected;
  const enabled = config.enabled;
  const isOperate = status?.operateMode === 'OPERATE';
  const isStandby = status?.operateMode === 'STANDBY';

  const fwd = status?.power?.forward;
  const refl = status?.power?.reflected;
  const swrReading = status?.power?.swr;
  const fwdValue = fwd?.value ?? 0;
  const reflValue = refl?.value ?? 0;
  const swrValue = swrReading?.value ?? 1.0;
  // Use the amp's reported max if present, else 1500 W (RF2K-S typical rated
  // max). The arc auto-scales its top-of-axis tick to this value.
  const ratedW = Math.max(1, fwd?.maxValue ?? 1500);

  const tuneCfgd = config.tuneClickX > 0 || config.tuneClickY > 0;
  const bypassCfgd = config.bypassClickX > 0 || config.bypassClickY > 0;

  async function handleTune() {
    if (!connected || !tuneCfgd || tuning) return;
    setTuning(true);
    try {
      await tune();
    } finally {
      // Brief tail so the amber pulse is visible even on fast clicks.
      setTimeout(() => setTuning(false), 1200);
    }
  }

  const shellStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: 'var(--immersive-panel)',
  };
  const bodyStyle: CSSProperties = {
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    background: 'var(--immersive-panel)',
    boxSizing: 'border-box',
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
  };

  if (showSettings) {
    return (
      <div style={shellStyle}>
        <Rf2kHeader
          title="RF2K-S Amplifier"
          settingsOpen={true}
          onGearClick={() => setShowSettings(false)}
          onClose={onRemove}
        />
        <div style={bodyStyle} aria-label="RF2K-S amplifier settings">
          <Rf2kSettings onClose={() => setShowSettings(false)} />
        </div>
      </div>
    );
  }

  const fwInfo = status?.info;
  const fwString = fwInfo?.softwareVersion
    ? formatFw(fwInfo.softwareVersion.controller, fwInfo.softwareVersion.gui)
    : '—';
  const modelString = fwInfo?.device ?? 'RF2K-S';

  // Status-text pill colouring mirrors the design: TX-orange when faulted /
  // tuning, neutral white when transmitting (operate + above mute), green
  // OK at idle.
  const statusBadge = resolveStatusBadge({
    connected,
    tuning,
    fault: status?.data?.status ?? null,
    operating: isOperate,
    swr: swrValue,
  });

  return (
    <div style={shellStyle}>
      <Rf2kHeader
        title="RF2K-S Amplifier"
        settingsOpen={false}
        onGearClick={() => setShowSettings(true)}
        onClose={onRemove}
      />
      <div style={bodyStyle} aria-label="RF2K-S amplifier — output, status, controls">

      {/* ── Hero meters ─────────────────────────────────────────────── */}
      <Section
        title="Output"
        led="on"
        meta={[
          { key: 'MODEL', value: modelString },
          { value: '·' },
          { key: 'FW', value: fwString },
        ]}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
          }}
        >
          <div style={{ position: 'relative' }}>
            <BigArc
              mode="watts"
              watts={connected ? fwdValue : 0}
              maxWatts={ratedW}
              label="Forward Power"
              units="Watts"
              defsId="rf2k-arc-fwd"
            />
            <ArcCorner>
              <em style={cornerEmStyle}>refl</em>
              {Math.round(reflValue)} W
            </ArcCorner>
          </div>
          <div style={{ position: 'relative' }}>
            <BigArc
              mode="swr"
              ratio={connected && Number.isFinite(swrValue) ? swrValue : 1.0}
              label="SWR"
              units="Ratio · :1"
              defsId="rf2k-arc-swr"
            />
            <ArcCorner>
              <em style={cornerEmStyle}>limit</em>2.0
            </ArcCorner>
          </div>
        </div>
      </Section>

      {/* ── Status chip strip ───────────────────────────────────────── */}
      <Section padding="12px 14px">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 8,
          }}
        >
          <Chip k="Band" v={fmtBandUnit(status?.data?.band)} />
          <Chip k="Freq" v={fmtFreq(status?.data?.frequency)} />
          <Chip k="Antenna" v={fmtAntenna(status?.activeAntenna)} />
          <Chip k="SWR" v={fmtNum(swrReading?.value, 2)} tone={swrTone(swrReading?.value)} />

          <Chip k="Tuner" v={status?.tuner?.mode ?? 'Off'} dim={!status?.tuner?.mode} />
          <Chip k="Temp" v={fmtUnitInline(status?.power?.temperature, 0, '°C')} />
          <Chip k="Voltage" v={fmtUnitInline(status?.power?.voltage, 1, 'V')} />
          <Chip k="Current" v={fmtUnitInline(status?.power?.current, 1, 'A')} />
        </div>
      </Section>

      {/* ── State row: Operate/Standby + status text + Tune/Bypass ──── */}
      <Section padding="14px">
        <div style={rowSplitStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <SegState
              isOperate={isOperate}
              isStandby={isStandby}
              connected={connected}
              onSelect={(v) => void setOperate(v === 'operate' ? 'OPERATE' : 'STANDBY')}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                style={{
                  fontSize: 9,
                  letterSpacing: '0.20em',
                  textTransform: 'uppercase',
                  color: 'var(--fg-3)',
                  fontWeight: 700,
                }}
              >
                Status
              </span>
              <span
                className="mono"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: statusBadge.color,
                  textShadow: statusBadge.glow ? `0 0 8px ${statusBadge.glow}` : undefined,
                }}
              >
                {statusBadge.text}
              </span>
            </div>
          </div>
          <BtnGroup>
            <PanelBtn
              tone={tuning ? 'warn-active' : 'warn'}
              disabled={!connected || !tuneCfgd}
              onClick={handleTune}
              title={
                !tuneCfgd
                  ? 'Tune button coordinates not calibrated. Open Settings.'
                  : 'Send a VNC mouse-click at the amp’s on-screen Tune button.'
              }
            >
              {tuning ? 'Tuning…' : 'Tune'}
            </PanelBtn>
            <PanelBtn
              disabled={!connected || !bypassCfgd}
              onClick={() => void bypass()}
              title={
                !bypassCfgd
                  ? 'Bypass button coordinates not calibrated. Open Settings.'
                  : 'Send a VNC mouse-click at the amp’s on-screen Bypass button.'
              }
            >
              Bypass
            </PanelBtn>
          </BtnGroup>
        </div>
      </Section>

      {/* ── Antenna picker ──────────────────────────────────────────── */}
      {status?.antennas && status.antennas.length > 0 && (
        <Section padding="14px">
          <PickerLabel hint={`${status.antennas.length} ports`}>Antenna</PickerLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {status.antennas.map((ant, i) => (
              <AntennaPick
                key={`${ant.type}-${ant.number ?? 'ext'}-${i}`}
                ant={ant}
                onClick={() =>
                  void setAntenna(ant.type === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL', ant.number ?? null)
                }
                disabled={!connected || ant.state === 'NOT_AVAILABLE'}
              />
            ))}
          </div>
        </Section>
      )}

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <Foot>
        <FootGrp>
          <FootStat
            ledTone={
              !enabled ? 'idle' : connected ? 'good' : 'warn'
            }
          >
            {!enabled ? 'Disabled' : connected ? 'Polling' : 'No Link'}
          </FootStat>
          <FootStat>
            <span>Host</span>
            <span style={footValueStyle}>{config.host || '—'}</span>
          </FootStat>
          {status?.lastSampleUtc && (
            <FootStat>
              <span>Sample</span>
              <span style={footValueStyle}>{fmtAge(status.lastSampleUtc)}</span>
            </FootStat>
          )}
        </FootGrp>
        <FootGrp>
          <PanelBtn
            tone="ghost-danger"
            small
            onClick={() => void reset()}
            disabled={!connected || !status?.data?.status}
          >
            Reset Fault
          </PanelBtn>
        </FootGrp>
      </Foot>

      {/* ── Click-result toast (transient) ──────────────────────────── */}
      {lastClickResult && (
        <Toast ok={lastClickResult.ok}>
          {lastClickResult.ok
            ? '✓ Click sent successfully'
            : `✗ ${lastClickResult.error ?? 'Click failed'}`}
        </Toast>
      )}

      {/* ── Disabled / disconnected hint ────────────────────────────── */}
      {(!enabled || !connected) && configLoaded && (
        <Toast ok={!enabled} tone={enabled ? 'tx' : 'idle'}>
          {!enabled
            ? 'RF2K-S integration disabled. Open the gear icon to enable polling.'
            : `Not connected: ${status?.error ?? 'awaiting first poll'}`}
        </Toast>
      )}
      </div>
    </div>
  );
}

// ============================================================================
//  Tile header — drag handle, title, settings cog, close X. Matches the
//  AnalogMeterPanel pattern: panel is `headerless: true`, so it owns the
//  whole tile and supplies its own `.workspace-tile-header` for RGL drag.
// ============================================================================

function Rf2kHeader({
  title,
  settingsOpen,
  onGearClick,
  onClose,
}: {
  title: string;
  settingsOpen: boolean;
  onGearClick: () => void;
  onClose?: () => void;
}) {
  const stopDrag = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div className="workspace-tile-header">
      <span
        className="workspace-tile-drag-handle"
        aria-hidden="true"
        title="Drag to reposition"
      >
        <GripVertical size={12} />
      </span>
      <span className="workspace-tile-title" title={title}>
        {title}
      </span>
      <button
        type="button"
        className={`am-h-gear ${settingsOpen ? 'on' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onGearClick();
        }}
        onPointerDown={stopDrag}
        onMouseDown={stopDrag}
        aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
        aria-pressed={settingsOpen}
        title={settingsOpen ? 'Close settings' : 'Settings'}
      >
        <Settings size={14} />
      </button>
      {onClose && (
        <button
          type="button"
          className="workspace-tile-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          onPointerDown={stopDrag}
          onMouseDown={stopDrag}
          aria-label={`Remove ${title}`}
          title="Remove panel"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ============================================================================
//  Section card — same chrome the immersive TX Stage Meters use
// ============================================================================

interface MetaItem {
  key?: string;
  value: string;
}

function Section({
  title,
  led,
  meta,
  children,
  padding = 14,
}: {
  title?: string;
  led?: 'on' | 'warm' | 'tx';
  meta?: MetaItem[];
  children: ReactNode;
  padding?: number | string;
}) {
  const sectionStyle: CSSProperties = {
    background:
      'linear-gradient(180deg, var(--immersive-panel-2) 0%, var(--immersive-well) 100%)',
    border: '1px solid var(--immersive-line)',
    borderRadius: 8,
    padding,
    boxShadow:
      'inset 0 1px 0 var(--immersive-rim), inset 0 0 30px rgba(0,0,0,0.25)',
    position: 'relative',
  };
  return (
    <section style={sectionStyle}>
      {(title || meta) && <SecHeader title={title} led={led} meta={meta} />}
      {children}
    </section>
  );
}

function SecHeader({
  title,
  led,
  meta,
}: {
  title?: string;
  led?: 'on' | 'warm' | 'tx';
  meta?: MetaItem[];
}) {
  const dotColor =
    led === 'on'
      ? 'var(--immersive-accent)'
      : led === 'warm'
        ? 'var(--immersive-warn)'
        : led === 'tx'
          ? 'var(--immersive-tx)'
          : 'var(--fg-3)';
  const dotGlow =
    led === 'on'
      ? '0 0 6px var(--immersive-accent-glow)'
      : led === 'warm'
        ? '0 0 6px var(--immersive-warn-glow)'
        : led === 'tx'
          ? '0 0 6px var(--immersive-tx-glow)'
          : undefined;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: title ? 12 : 0,
      }}
    >
      {title && (
        <div
          style={{
            fontSize: 9.5,
            letterSpacing: '0.20em',
            textTransform: 'uppercase',
            color: 'var(--fg-2)',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: 9,
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: dotColor,
              boxShadow: dotGlow,
            }}
          />
          {title}
        </div>
      )}
      {meta && meta.length > 0 && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            color: 'var(--fg-3)',
            letterSpacing: '0.06em',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
          }}
        >
          {meta.map((m, i) => (
            <span key={i}>
              {m.key && (
                <span style={{ color: 'var(--fg-2)' }}>{m.key} </span>
              )}
              <span>{m.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
//  Status chip
// ============================================================================

function Chip({
  k,
  v,
  tone,
  dim = false,
}: {
  k: string;
  v: string;
  tone?: 'good' | 'warn' | 'bad';
  dim?: boolean;
}) {
  // Untoned chip values now read in warm-cream so the chip strip looks
  // backlit by the same lamp that lights the gauges. Semantic tones
  // (good/warn/bad) keep their green/amber/red colour cues.
  let valueColor: string = 'var(--immersive-lamp-chip-text)';
  let glow: string | undefined = '0 0 8px var(--immersive-lamp-chip-text-glow)';
  if (tone === 'good') {
    valueColor = 'var(--immersive-good)';
    glow = '0 0 8px var(--immersive-good-glow)';
  } else if (tone === 'warn') {
    valueColor = 'var(--immersive-warn)';
    glow = '0 0 8px var(--immersive-warn-glow)';
  } else if (tone === 'bad') {
    valueColor = 'var(--immersive-tx)';
    glow = '0 0 8px var(--immersive-tx-glow)';
  } else if (dim) {
    valueColor = 'var(--fg-2)';
    glow = undefined;
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '8px 11px',
        borderRadius: 6,
        // Lamp-glow recipe: cream radial bloom rising from the bottom
        // edge over a dark linear base, mirroring the gauge cards.
        background:
          'radial-gradient(80% 100% at 50% 100%, var(--immersive-lamp-chip-bloom), transparent 70%),' +
          ' linear-gradient(180deg, #161618 0%, #0c0c0e 100%)',
        border: '1px solid var(--immersive-lamp-border)',
        boxShadow:
          'inset 0 1px 0 var(--immersive-lamp-rim), inset 0 -8px 14px rgba(255,240,180,0.03)',
      }}
    >
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--fg-3)',
          fontWeight: 700,
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: valueColor,
          fontWeight: 600,
          letterSpacing: '0.02em',
          textShadow: glow,
        }}
      >
        {v}
      </span>
    </div>
  );
}

// ============================================================================
//  Operate / Standby segmented control
// ============================================================================

function SegState({
  isOperate,
  isStandby,
  connected,
  onSelect,
}: {
  isOperate: boolean;
  isStandby: boolean;
  connected: boolean;
  onSelect: (v: 'operate' | 'standby') => void;
}) {
  const segStyle: CSSProperties = {
    display: 'inline-flex',
    padding: 3,
    borderRadius: 7,
    background:
      'linear-gradient(180deg, var(--immersive-well) 0%, var(--immersive-well-2) 100%)',
    border: '1px solid var(--immersive-line)',
    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)',
  };
  return (
    <div style={segStyle}>
      <SegBtn
        active={isOperate}
        variant="operate"
        disabled={!connected}
        onClick={() => onSelect('operate')}
      >
        Operate
      </SegBtn>
      <SegBtn
        active={isStandby || (!isOperate && !isStandby)}
        variant="standby"
        disabled={!connected}
        onClick={() => onSelect('standby')}
      >
        Standby
      </SegBtn>
    </div>
  );
}

function SegBtn({
  active,
  variant,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  variant: 'operate' | 'standby';
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  // Match Amplifier.html (chat12 final state): operate => warm-cream lit
  // pill (lamp-glow tone matching the gauge faces), standby => tx-orange
  // tinted pill (the "armed but not transmitting" colour that Thetis
  // and the RF2K-S share).
  const activeStyle: CSSProperties =
    variant === 'operate'
      ? {
          color: '#fbf8ec',
          background: 'linear-gradient(180deg,#33332e,#1f1f1c)',
          boxShadow:
            'inset 0 1px 0 rgba(255,250,220,0.26), 0 0 0 1px rgba(245,240,200,0.32), 0 0 16px var(--immersive-lamp-active-glow)',
        }
      : {
          color: '#ffd0c5',
          background: 'linear-gradient(180deg,#3a1a14,#2a110d)',
          boxShadow:
            'inset 0 1px 0 rgba(239,107,84,0.4), 0 0 0 1px rgba(239,107,84,0.45), 0 0 14px var(--immersive-tx-glow)',
        };
  const baseStyle: CSSProperties = {
    fontFamily: 'inherit',
    fontSize: 11.5,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '9px 18px',
    borderRadius: 5,
    border: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: 'transparent',
    color: 'var(--fg-2)',
    transition: '0.15s',
    opacity: disabled ? 0.55 : 1,
    ...(active ? activeStyle : null),
  };
  return (
    <button type="button" style={baseStyle} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

// ============================================================================
//  Buttons (Tune / Bypass / Reset / Settings)
// ============================================================================

type BtnTone = 'default' | 'warn' | 'warn-active' | 'ghost' | 'ghost-danger' | 'primary';

function PanelBtn({
  tone = 'default',
  small = false,
  disabled,
  onClick,
  title,
  children,
}: {
  tone?: BtnTone;
  small?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
}) {
  const palette: Record<BtnTone, CSSProperties> = {
    default: {
      color: 'var(--fg-1)',
      background: 'linear-gradient(180deg,#171c27 0%, #11151d 100%)',
      borderColor: 'var(--immersive-line-2)',
    },
    warn: {
      color: 'var(--immersive-warn)',
      background: 'linear-gradient(180deg,#171c27 0%, #11151d 100%)',
      borderColor: 'rgba(244,193,104,0.35)',
    },
    'warn-active': {
      color: 'var(--immersive-warn)',
      background: 'linear-gradient(180deg,#3a2a14,#2a1d0d)',
      borderColor: 'rgba(244,193,104,0.7)',
      boxShadow:
        '0 0 16px var(--immersive-warn-glow), inset 0 1px 0 rgba(244,193,104,0.4)',
    },
    ghost: {
      color: 'var(--fg-2)',
      background: 'transparent',
      borderColor: 'var(--immersive-line)',
    },
    'ghost-danger': {
      color: 'var(--immersive-tx)',
      background: 'transparent',
      borderColor: 'rgba(239,107,84,0.35)',
    },
    primary: {
      color: '#0b0d12',
      background: 'linear-gradient(180deg,#f1f2f5,#cfd1d6)',
      borderColor: '#dadbe0',
      boxShadow:
        'inset 0 1px 0 rgba(255,255,255,0.45), 0 0 14px rgba(255,255,255,0.18)',
    },
  };
  const p = palette[tone];
  const style: CSSProperties = {
    fontFamily: 'inherit',
    fontSize: small ? 10 : 11.5,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: small ? '6px 12px' : '10px 16px',
    borderRadius: 6,
    border: '1px solid',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: '0.15s',
    opacity: disabled ? 0.5 : 1,
    boxShadow:
      tone === 'warn-active'
        ? p.boxShadow
        : 'inset 0 1px 0 var(--immersive-rim), 0 1px 0 rgba(0,0,0,0.4)',
    ...p,
  };
  return (
    <button type="button" style={style} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

function BtnGroup({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 0,
        borderRadius: 6,
        overflow: 'hidden',
        border: '1px solid var(--immersive-line-2)',
        boxShadow: 'inset 0 1px 0 var(--immersive-rim), 0 1px 0 rgba(0,0,0,0.4)',
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
//  Antenna pill picker
// ============================================================================

function PickerLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        letterSpacing: '0.20em',
        textTransform: 'uppercase',
        color: 'var(--fg-2)',
        fontWeight: 700,
        marginBottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {children}
      {hint && (
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--fg-3)',
            letterSpacing: '0.06em',
            textTransform: 'none',
            fontWeight: 500,
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

function AntennaPick({
  ant,
  onClick,
  disabled,
}: {
  ant: Rf2kAntenna;
  onClick: () => void;
  disabled?: boolean;
}) {
  const active = ant.state === 'ACTIVE';
  const isExt = ant.type === 'EXTERNAL';
  const label = isExt ? 'EXT' : `INT-${ant.number ?? '?'}`;
  return (
    <Pill active={active} ext={isExt} disabled={disabled} onClick={onClick}>
      {label}
    </Pill>
  );
}

function Pill({
  active,
  ext = false,
  disabled,
  onClick,
  children,
  title,
}: {
  active: boolean;
  ext?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  const baseStyle: CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.10em',
    padding: '7px 12px',
    borderRadius: 5,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: 'linear-gradient(180deg,#171c27 0%, #11151d 100%)',
    border: '1px solid var(--immersive-line-2)',
    color: 'var(--fg-2)',
    boxShadow: 'inset 0 1px 0 var(--immersive-rim)',
    transition: '0.12s',
    opacity: disabled ? 0.5 : 1,
  };
  const activeStyle: CSSProperties =
    ext && active
      ? {
          color: '#ffd0c5',
          background: 'linear-gradient(180deg,#3a1a14,#2a110d)',
          borderColor: 'rgba(239,107,84,0.5)',
          boxShadow:
            'inset 0 1px 0 rgba(239,107,84,0.3), 0 0 10px var(--immersive-tx-glow)',
        }
      : active
        ? {
            // Warm-cream lit pill matching the gauge-face lamp glow.
            color: '#fbf8ec',
            background: 'linear-gradient(180deg,#33332f,#1f1f1d)',
            borderColor: 'rgba(245,240,200,0.45)',
            boxShadow:
              'inset 0 1px 0 rgba(255,250,220,0.20), 0 0 12px var(--immersive-lamp-active-glow)',
          }
        : {};
  return (
    <button
      type="button"
      style={{ ...baseStyle, ...activeStyle }}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

// ============================================================================
//  Footer / toast / arc-corner readout
// ============================================================================

const cornerEmStyle: CSSProperties = {
  fontStyle: 'normal',
  color: 'var(--fg-2)',
  fontWeight: 600,
  marginRight: 4,
  fontSize: 10,
  letterSpacing: '0.04em',
};

function ArcCorner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        bottom: 10,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--fg-3)',
        letterSpacing: '0.04em',
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  );
}

const footValueStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg-1)',
  letterSpacing: '0.04em',
  textTransform: 'none',
  fontWeight: 600,
};

const rowSplitStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

function Foot({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 4px 2px',
        fontSize: 9.5,
        color: 'var(--fg-3)',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      {children}
    </div>
  );
}

function FootGrp({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>{children}</div>;
}

function FootStat({
  ledTone,
  children,
}: {
  ledTone?: 'good' | 'warn' | 'idle';
  children: ReactNode;
}) {
  const ledStyle: CSSProperties | null = ledTone
    ? {
        width: 6,
        height: 6,
        borderRadius: '50%',
        background:
          ledTone === 'good'
            ? 'var(--immersive-good)'
            : ledTone === 'warn'
              ? 'var(--immersive-warn)'
              : 'var(--fg-3)',
        boxShadow:
          ledTone === 'good'
            ? '0 0 6px var(--immersive-good-glow)'
            : ledTone === 'warn'
              ? '0 0 6px var(--immersive-warn-glow)'
              : undefined,
      }
    : null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {ledStyle && <span style={ledStyle} />}
      {children}
    </div>
  );
}

function Toast({
  ok,
  tone,
  children,
}: {
  ok: boolean;
  tone?: 'tx' | 'idle';
  children: ReactNode;
}) {
  // The disabled / idle toast was reading as grey-on-black, which is
  // hard to scan over the dark panel chrome. Promote disabled-state
  // copy to amber (it's a "you need to do something" warning, not a
  // success or an error) and bump the success copy to bright cream so
  // it pops against the green-tinted bg without losing contrast.
  const baseColor =
    tone === 'idle'
      ? 'var(--immersive-warn)'
      : ok
        ? '#d8f5e4'
        : '#ffd7cc';
  const baseBg =
    tone === 'idle'
      ? 'rgba(244,193,104,0.10)'
      : ok
        ? 'rgba(92,212,154,0.10)'
        : 'rgba(239,107,84,0.12)';
  const borderColor =
    tone === 'idle'
      ? 'rgba(244,193,104,0.45)'
      : ok
        ? 'rgba(92,212,154,0.45)'
        : 'rgba(239,107,84,0.45)';
  const glow =
    tone === 'idle'
      ? '0 0 8px var(--immersive-warn-glow)'
      : ok
        ? '0 0 8px var(--immersive-good-glow)'
        : '0 0 8px var(--immersive-tx-glow)';
  return (
    <div
      style={{
        padding: 8,
        fontSize: 11,
        color: baseColor,
        background: baseBg,
        border: `1px solid ${borderColor}`,
        borderRadius: 6,
        textShadow: glow,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
//  Settings drawer
// ============================================================================

function Rf2kSettings({ onClose }: { onClose: () => void }) {
  const config = useRf2kStore((s) => s.config);
  const status = useRf2kStore((s) => s.status);
  const testInFlight = useRf2kStore((s) => s.testInFlight);
  const lastTestResult = useRf2kStore((s) => s.lastTestResult);
  const lastClickResult = useRf2kStore((s) => s.lastClickResult);
  const saveConfig = useRf2kStore((s) => s.saveConfig);
  const test = useRf2kStore((s) => s.test);
  const click = useRf2kStore((s) => s.click);
  const setInterface = useRf2kStore((s) => s.setInterface);

  const [enabled, setEnabled] = useState(config.enabled);
  const [host, setHost] = useState(config.host);
  const [port, setPort] = useState(String(config.port));
  const [vncPort, setVncPort] = useState(String(config.vncPort));
  const [vncPassword, setVncPassword] = useState(config.vncPassword);
  const [tuneX, setTuneX] = useState(String(config.tuneClickX));
  const [tuneY, setTuneY] = useState(String(config.tuneClickY));
  const [bypassX, setBypassX] = useState(String(config.bypassClickX));
  const [bypassY, setBypassY] = useState(String(config.bypassClickY));
  const [calibX, setCalibX] = useState('512');
  const [calibY, setCalibY] = useState('300');
  const [saving, setSaving] = useState(false);

  // Re-sync local form state when the store rehydrates from /api/rf2k/config.
  useEffect(() => {
    setEnabled(config.enabled);
    setHost(config.host);
    setPort(String(config.port));
    setVncPort(String(config.vncPort));
    setVncPassword(config.vncPassword);
    setTuneX(String(config.tuneClickX));
    setTuneY(String(config.tuneClickY));
    setBypassX(String(config.bypassClickX));
    setBypassY(String(config.bypassClickY));
  }, [config]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const portNum = Number(port);
      const vncPortNum = Number(vncPort);
      if (!validPort(portNum) || !validPort(vncPortNum)) return;
      const next: Rf2kConfig = {
        enabled,
        host: host.trim() || '10.70.120.41',
        port: portNum,
        vncPort: vncPortNum,
        vncPassword,
        pollingIntervalMs: config.pollingIntervalMs,
        tuneClickX: Number(tuneX) || 0,
        tuneClickY: Number(tuneY) || 0,
        bypassClickX: Number(bypassX) || 0,
        bypassClickY: Number(bypassY) || 0,
      };
      await saveConfig(next);
    } finally {
      setSaving(false);
    }
  }

  async function onTestConnection() {
    const portNum = Number(port);
    if (!validPort(portNum)) return;
    await test(host.trim() || '10.70.120.41', portNum);
  }

  async function onCalibClick() {
    const x = Number(calibX);
    const y = Number(calibY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    await click(x, y);
  }

  return (
    <form onSubmit={onSave} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Connection ──────────────────────────────────────────────── */}
      <Section
        title="Connection"
        led="on"
        meta={[{ key: 'REST + VNC', value: '' }]}
        padding="14px"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Check checked={enabled} onChange={setEnabled}>
            Enabled <span style={{ color: 'var(--fg-3)' }}>(poll the amp)</span>
          </Check>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <Field label="Host">
              <Input value={host} onChange={setHost} placeholder="10.70.120.41" />
            </Field>
            <Field label="REST Port">
              <Input value={port} onChange={setPort} type="number" />
            </Field>
            <Field label="VNC Port">
              <Input value={vncPort} onChange={setVncPort} type="number" />
            </Field>
          </div>

          <Field
            label="VNC Password"
            help={
              <>
                Required if the amp&apos;s vncserver demands authentication (RFB security
                type 2). Leave blank if VNC is set to allow anonymous connections.
                Truncated to 8 characters per the RFB password protocol; treated as a
                low-value LAN credential, stored unencrypted in{' '}
                <span
                  style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-2)' }}
                >
                  zeus-prefs.db
                </span>
                .
              </>
            }
          >
            <Input value={vncPassword} onChange={setVncPassword} type="password" />
          </Field>

          <div style={rowSplitStyle}>
            <PanelBtn small onClick={onTestConnection} disabled={testInFlight}>
              {testInFlight ? 'Testing…' : 'Test REST'}
            </PanelBtn>
            <div style={{ display: 'flex', gap: 8 }}>
              <PanelBtn small onClick={onClose} tone="ghost">
                Cancel
              </PanelBtn>
              <button
                type="submit"
                disabled={saving}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid #dadbe0',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  color: '#0b0d12',
                  background: 'linear-gradient(180deg,#f1f2f5,#cfd1d6)',
                  boxShadow:
                    'inset 0 1px 0 rgba(255,255,255,0.45), 0 0 14px rgba(255,255,255,0.18)',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          {lastTestResult && (
            <Toast ok={lastTestResult.ok}>
              {lastTestResult.ok
                ? `✓ Reached RF2K-S at ${host}:${port}`
                : `✗ ${lastTestResult.error ?? 'unknown error'}`}
            </Toast>
          )}

          {status?.error && <Toast ok={false}>{status.error}</Toast>}
        </div>
      </Section>

      {/* ── Control Source ──────────────────────────────────────────── */}
      <Section
        title="Control Source"
        led="on"
        meta={[{ key: 'CAT/UDP/TCI link', value: '' }]}
        padding="14px"
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {INTERFACE_MODES.map((m) => {
            const active = status?.operationalInterface === m;
            return (
              <Pill
                key={m}
                active={active}
                onClick={() => void setInterface(m)}
                disabled={!status?.connected}
                title={
                  m === 'TCI'
                    ? 'Point amp at Zeus’s TCI server for auto-band-follow.'
                    : `Set amp control source to ${m}.`
                }
              >
                {m}
              </Pill>
            );
          })}
        </div>
        {status?.operationalInterfaceError && (
          <div style={{ marginTop: 8 }}>
            <Toast ok={false}>{status.operationalInterfaceError}</Toast>
          </div>
        )}
      </Section>

      {/* ── VNC Click Calibration ───────────────────────────────────── */}
      <Section
        title="VNC Click Calibration"
        led="warm"
        meta={[{ key: 'PANEL', value: '1024 × 600' }]}
        padding="14px"
      >
        <p
          style={{
            margin: '0 0 14px',
            fontSize: 12,
            color: 'var(--fg-2)',
            lineHeight: 1.55,
          }}
        >
          The amp&apos;s REST API doesn&apos;t expose{' '}
          <em style={{ color: 'var(--fg-1)', fontStyle: 'normal' }}>Tune</em> or
          tuner-mode toggle. We send a VNC mouse-click at the on-screen button. Use
          the{' '}
          <em style={{ color: 'var(--fg-1)', fontStyle: 'normal' }}>Test Click</em>{' '}
          field to find the right pixel coordinates, then save them as Tune /
          Bypass.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Field label="Tune X">
            <Input value={tuneX} onChange={setTuneX} type="number" />
          </Field>
          <Field label="Tune Y">
            <Input value={tuneY} onChange={setTuneY} type="number" />
          </Field>
          <Field label="Bypass X">
            <Input value={bypassX} onChange={setBypassX} type="number" />
          </Field>
          <Field label="Bypass Y">
            <Input value={bypassY} onChange={setBypassY} type="number" />
          </Field>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 200px',
            gap: 10,
            marginTop: 10,
            alignItems: 'end',
          }}
        >
          <Field label="Test X">
            <Input value={calibX} onChange={setCalibX} type="number" />
          </Field>
          <Field label="Test Y">
            <Input value={calibY} onChange={setCalibY} type="number" />
          </Field>
          <PanelBtn onClick={onCalibClick}>Send Test Click</PanelBtn>
        </div>
        {lastClickResult && (
          <div style={{ marginTop: 10 }}>
            <Toast ok={lastClickResult.ok}>
              {lastClickResult.ok
                ? '✓ Click sent — watch the amp screen to confirm it landed on the right button'
                : `✗ ${lastClickResult.error ?? 'click failed'}`}
            </Toast>
          </div>
        )}
      </Section>

      <Foot>
        <FootGrp>
          <FootStat ledTone={status?.connected ? 'good' : 'warn'}>
            {status?.connected ? 'Connected' : 'Offline'}
          </FootStat>
          {status?.connected && (
            <FootStat>
              <span>REST</span>
              <span style={footValueStyle}>200 OK</span>
            </FootStat>
          )}
        </FootGrp>
        <FootGrp>
          <PanelBtn small onClick={onClose}>
            Done
          </PanelBtn>
        </FootGrp>
      </Foot>
    </form>
  );
}

// ============================================================================
//  Form atoms
// ============================================================================

function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactNode;
  help?: ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--fg-2)',
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      {children}
      {help && (
        <span
          style={{
            fontSize: 11,
            color: 'var(--fg-3)',
            lineHeight: 1.55,
            letterSpacing: 0,
            textTransform: 'none',
          }}
        >
          {help}
        </span>
      )}
    </label>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'number' | 'password';
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      style={{
        font: 'inherit',
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        background:
          'linear-gradient(180deg, var(--immersive-well) 0%, var(--immersive-well-2) 100%)',
        border: '1px solid var(--immersive-line-2)',
        color: 'var(--fg-0)',
        borderRadius: 6,
        padding: '9px 11px',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)',
        outline: 'none',
        minWidth: 0,
      }}
    />
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        cursor: 'pointer',
        userSelect: 'none',
        fontSize: 13,
        color: 'var(--fg-1)',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ display: 'none' }}
      />
      <span
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          background: checked
            ? 'linear-gradient(180deg,#e8eaef,#c4c6cc)'
            : 'linear-gradient(180deg, var(--immersive-well) 0%, var(--immersive-well-2) 100%)',
          border: checked
            ? '1.5px solid #dadbe0'
            : '1.5px solid var(--immersive-line-2)',
          display: 'grid',
          placeItems: 'center',
          transition: '0.15s',
          boxShadow: checked
            ? '0 0 10px rgba(255,255,255,0.18)'
            : 'inset 0 1px 2px rgba(0,0,0,0.5)',
        }}
      >
        {checked && (
          <span
            style={{
              width: 9,
              height: 5,
              borderLeft: '2px solid #0b0d12',
              borderBottom: '2px solid #0b0d12',
              transform: 'rotate(-45deg) translate(1px,-1px)',
            }}
          />
        )}
      </span>
      <span>{children}</span>
    </label>
  );
}

// ============================================================================
//  Helpers
// ============================================================================

function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function fmtUnitInline(
  r: { value?: number; unit?: string | null } | null | undefined,
  digits: number,
  fallbackUnit: string,
): string {
  if (!r || !Number.isFinite(r.value)) return '—';
  const n = (r.value as number).toFixed(digits);
  return `${n} ${r.unit ?? fallbackUnit}`;
}

function fmtBandUnit(r: { value?: number; unit?: string | null } | null | undefined): string {
  if (!r || !Number.isFinite(r.value)) return '—';
  return `${r.value}${r.unit ?? ''}`;
}

function fmtFreq(r: { value?: number; unit?: string | null } | null | undefined): string {
  if (!r || !Number.isFinite(r.value)) return '—';
  // Amp returns kHz; show MHz for ≥1 MHz
  const v = r.value as number;
  if (v >= 1000) return `${(v / 1000).toFixed(3)} MHz`;
  return `${v.toFixed(0)} kHz`;
}

function fmtAntenna(a: { type?: string | null; number?: number | null } | null | undefined): string {
  if (!a) return '—';
  if (a.type === 'EXTERNAL') return 'EXT';
  return `INT-${a.number ?? '?'}`;
}

function fmtAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const ageS = Math.max(0, (Date.now() - t) / 1000);
  if (ageS < 2) return 'live';
  if (ageS < 60) return `${Math.round(ageS)} s ago`;
  return `${Math.round(ageS / 60)} m ago`;
}

function formatFw(controller: number | null, gui: number | null): string {
  const c = controller != null && Number.isFinite(controller) ? controller.toFixed(2) : null;
  const g = gui != null && Number.isFinite(gui) ? gui.toFixed(2) : null;
  if (c && g) return `${c}/${g}`;
  return c ?? g ?? '—';
}

function swrTone(swr: number | null | undefined): 'good' | 'warn' | 'bad' | undefined {
  if (swr == null || !Number.isFinite(swr)) return undefined;
  if (swr >= 2.0) return 'bad';
  if (swr >= 1.5) return 'warn';
  return 'good';
}

interface StatusBadge {
  text: string;
  color: string;
  glow?: string;
}

function resolveStatusBadge({
  connected,
  tuning,
  fault,
  operating,
  swr,
}: {
  connected: boolean;
  tuning: boolean;
  fault: string | null;
  operating: boolean;
  swr: number;
}): StatusBadge {
  if (!connected) {
    return { text: 'Offline', color: 'var(--fg-3)' };
  }
  if (tuning) {
    return {
      text: 'Tuning',
      color: 'var(--immersive-warn)',
      glow: 'var(--immersive-warn-glow)',
    };
  }
  if (fault) {
    return {
      text: fault,
      color: 'var(--immersive-tx)',
      glow: 'var(--immersive-tx-glow)',
    };
  }
  if (Number.isFinite(swr) && swr > 2.5) {
    return {
      text: 'High SWR',
      color: 'var(--immersive-tx)',
      glow: 'var(--immersive-tx-glow)',
    };
  }
  if (operating) {
    return {
      text: 'Transmit',
      color: 'var(--immersive-accent)',
      glow: 'var(--immersive-accent-glow)',
    };
  }
  return {
    text: 'OK',
    color: 'var(--immersive-good)',
    glow: 'var(--immersive-good-glow)',
  };
}

function validPort(p: number): boolean {
  return Number.isFinite(p) && p > 0 && p < 65536;
}
