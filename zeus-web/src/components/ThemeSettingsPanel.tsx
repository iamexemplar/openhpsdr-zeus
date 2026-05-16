// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
// See LICENSE for the full GPL text.

import type { CSSProperties } from 'react';
import {
  TWEAKABLE_TOKENS,
  useThemeStore,
  type ThemeId,
  type TweakableToken,
} from '../state/theme-store';

// Operator-facing label + default colour per tweakable token. The default
// is the value that ships in tokens.css for the DARK theme; that's what
// resetting an override falls back to (the light overlay then re-skins
// surface colours independently). Keep this aligned with tokens.css —
// the colour rectangle in the picker only matches when the default
// matches the stylesheet.
const TOKEN_META: Record<
  TweakableToken,
  { label: string; help: string; default: string }
> = {
  '--accent': {
    label: 'Accent',
    help: 'Active controls, selection rings, sidebar highlight.',
    default: '#0c5f9c',
  },
  '--accent-bright': {
    label: 'Accent (bright)',
    help: 'Highlighted text — VFO label, value digits.',
    default: '#4ea6ff',
  },
  '--tx': {
    label: 'TX',
    help: 'MOX / ON-AIR red, gain-reduction caps.',
    default: '#ff4a59',
  },
  '--power': {
    label: 'Power',
    help: 'Forward-power, drive digits, yellow accents.',
    default: '#ffb13c',
  },
  '--amber': {
    label: 'Amber',
    help: 'Warning band on meters, warm halo around LEDs.',
    default: '#ffb13c',
  },
  '--cyan': {
    label: 'Cyan',
    help: 'Secondary signal indicators, scope grid.',
    default: '#4dc9ff',
  },
  '--ok': {
    label: 'OK / Green',
    help: 'Healthy state, lower band of meter ramps.',
    default: '#2dd566',
  },
  '--orange': {
    label: 'Orange',
    help: 'Mid band on meter ramps, intermediate signals.',
    default: '#ff8a3c',
  },
};

const THEME_OPTIONS: ReadonlyArray<{
  id: ThemeId;
  label: string;
  blurb: string;
  swatch: string;
}> = [
  {
    id: 'dark',
    label: 'Dark',
    blurb: 'Near-black chrome, lit-display feel. The original Zeus aesthetic.',
    swatch: '#0a0a0c',
  },
  {
    id: 'light',
    label: 'Light',
    blurb: 'Brushed-silver chassis with dark display wells. Day-shack mode.',
    swatch: '#c4c8ce',
  },
];

function isHexColor(v: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(v);
}

export function ThemeSettingsPanel() {
  const theme = useThemeStore((s) => s.theme);
  const overrides = useThemeStore((s) => s.overrides);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setOverride = useThemeStore((s) => s.setOverride);
  const resetOverrides = useThemeStore((s) => s.resetOverrides);

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={sectionHead}>
          <h3 style={sectionH3}>Theme</h3>
          <p style={sectionP}>
            Pick the workspace look. Display surfaces (panadapter, gauges,
            VFO) stay dark in both themes so signals stay readable.
          </p>
        </div>

        <div style={themeGrid}>
          {THEME_OPTIONS.map((opt) => {
            const active = theme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={active}
                onClick={() => setTheme(opt.id)}
                style={themeCard(active)}
              >
                <span style={{ ...themeSwatch, background: opt.swatch }} />
                <span style={themeCardBody}>
                  <span style={themeLabel}>{opt.label}</span>
                  <span style={themeBlurb}>{opt.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div style={sectionHead}>
          <h3 style={sectionH3}>Colour palette</h3>
          <p style={sectionP}>
            Tweak any of the accent colours. Changes apply to both themes.
            Clearing a value (Reset) restores the default for that token.
          </p>
        </div>

        <div style={paletteList}>
          {TWEAKABLE_TOKENS.map((tok) => {
            const meta = TOKEN_META[tok];
            const overridden = overrides[tok];
            const current = (overridden ?? meta.default).toUpperCase();
            return (
              <div key={tok} style={paletteRow}>
                <div style={paletteLabels}>
                  <span style={paletteLabel}>{meta.label}</span>
                  <span style={paletteHelp}>{meta.help}</span>
                </div>
                <div style={paletteControls}>
                  <input
                    type="color"
                    value={current}
                    onChange={(e) =>
                      setOverride(tok, e.target.value.toUpperCase())
                    }
                    style={pickerStyle}
                    aria-label={`${meta.label} colour`}
                  />
                  <input
                    type="text"
                    value={current}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      const v = raw.startsWith('#') ? raw : `#${raw}`;
                      if (isHexColor(v)) setOverride(tok, v.toUpperCase());
                    }}
                    maxLength={7}
                    spellCheck={false}
                    style={hexInput}
                    aria-label={`${meta.label} hex value`}
                  />
                  <button
                    type="button"
                    onClick={() => setOverride(tok, null)}
                    disabled={!overridden}
                    style={resetBtn(!!overridden)}
                    title="Restore default"
                  >
                    Reset
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div style={footerRow}>
          <button
            type="button"
            onClick={resetOverrides}
            disabled={!hasOverrides}
            style={resetAllBtn(hasOverrides)}
          >
            Reset all colours
          </button>
        </div>
      </div>
    </section>
  );
}

const sectionHead: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  gap: 10,
  marginBottom: 12,
};
const sectionH3: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--fg-0)',
};
const sectionP: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--fg-2)',
};

const themeGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: 10,
};

function themeCard(active: boolean): CSSProperties {
  return {
    display: 'flex',
    gap: 12,
    padding: 14,
    background: active ? 'var(--bg-2)' : 'var(--bg-1)',
    border: `1.5px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
    borderRadius: 'var(--r-md)',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'border-color var(--dur-fast), background var(--dur-fast)',
    boxShadow: active
      ? '0 0 0 3px rgba(46,142,255,0.18)'
      : 'inset 0 0 0 1px rgba(255,255,255,0.02)',
  };
}

const themeSwatch: CSSProperties = {
  width: 36,
  height: 36,
  flex: 'none',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--line-strong)',
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
};

const themeCardBody: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
};

const themeLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--fg-0)',
  letterSpacing: '0.04em',
};

const themeBlurb: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--fg-2)',
};

const paletteList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  background: 'var(--bg-1)',
  overflow: 'hidden',
};

const paletteRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  alignItems: 'center',
  gap: 14,
  padding: '11px 14px',
  borderTop: '1px solid var(--line-soft)',
};

const paletteLabels: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  minWidth: 0,
};

const paletteLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--fg-0)',
};

const paletteHelp: CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-2)',
  lineHeight: 1.4,
};

const paletteControls: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const pickerStyle: CSSProperties = {
  width: 34,
  height: 24,
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--line-strong)',
  padding: 0,
  background: 'transparent',
  cursor: 'pointer',
  overflow: 'hidden',
};

const hexInput: CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--line)',
  color: 'var(--fg-0)',
  borderRadius: 'var(--r-sm)',
  padding: '5px 8px',
  width: 92,
  fontSize: 12,
  letterSpacing: '0.04em',
  fontFamily: 'var(--font-mono)',
};

function resetBtn(enabled: boolean): CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--line-strong)',
    color: enabled ? 'var(--fg-1)' : 'var(--fg-3)',
    borderRadius: 'var(--r-sm)',
    padding: '5px 10px',
    fontSize: 11,
    letterSpacing: '0.06em',
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.5,
  };
}

const footerRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: 10,
};

function resetAllBtn(enabled: boolean): CSSProperties {
  return {
    background: enabled ? 'var(--bg-2)' : 'transparent',
    border: '1px solid var(--line-strong)',
    color: enabled ? 'var(--fg-0)' : 'var(--fg-3)',
    borderRadius: 'var(--r-sm)',
    padding: '7px 14px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.5,
  };
}
