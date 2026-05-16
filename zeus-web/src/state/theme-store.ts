// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
// See LICENSE for the full GPL text.

import { create } from 'zustand';

// Theme + per-token colour overrides for the Zeus UI.
//
// `theme` flips the global `data-theme` attribute on <html>, which selects
// either the default dark token set in tokens.css or the brushed-silver
// LIGHT overlay (`:root[data-theme="light"]`). The operator can additionally
// override individual CSS variables — e.g. nudge --accent from electric blue
// to teal — and those overrides apply across BOTH themes because they're
// injected via a runtime <style> tag that sets `:root { … }` after the
// theme-block in the stylesheet.
//
// Stored in localStorage (not on the server) because:
//   1. theming is per-browser ergonomics, not per-radio config — Brian on
//      his laptop should be able to pick a light scheme without it flipping
//      his shack tablet to silver as well;
//   2. it parallels the existing `zeus.variant` / `zeus.fonts` keys already
//      written from App.tsx;
//   3. the user can wipe localStorage to factory-reset their chrome.

export type ThemeId = 'dark' | 'light';

// Tokens we expose in the operator-facing colour-tweak UI. These are the
// "feel" tokens an operator notices: accent for active controls, signal
// chain colours, and the warm halos on meters. Surface colours (--bg-0
// etc.) are NOT tweakable here — they are governed by the theme overlay,
// because flipping bg-0 in isolation tends to make text unreadable.
// Add a token here + a label in TWEAKABLE_TOKEN_META if you want a new
// slider in the Theme panel.
export type TweakableToken =
  | '--accent'
  | '--accent-bright'
  | '--tx'
  | '--power'
  | '--amber'
  | '--cyan'
  | '--ok'
  | '--orange';

export const TWEAKABLE_TOKENS: ReadonlyArray<TweakableToken> = [
  '--accent',
  '--accent-bright',
  '--tx',
  '--power',
  '--amber',
  '--cyan',
  '--ok',
  '--orange',
];

type ThemeState = {
  theme: ThemeId;
  // Map of CSS-variable-name → hex colour (e.g. `--accent` → `#FF00FF`).
  // Only entries present here override the stylesheet default; deleting a
  // key restores the original token value from tokens.css.
  overrides: Partial<Record<TweakableToken, string>>;
  setTheme: (t: ThemeId) => void;
  setOverride: (token: TweakableToken, hex: string | null) => void;
  resetOverrides: () => void;
};

const THEME_KEY = 'zeus.theme';
const OVERRIDES_KEY = 'zeus.theme.overrides';

function isThemeId(v: unknown): v is ThemeId {
  return v === 'dark' || v === 'light';
}

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
}

function readTheme(): ThemeId {
  try {
    if (typeof localStorage === 'undefined') return 'dark';
    const raw = localStorage.getItem(THEME_KEY);
    return isThemeId(raw) ? raw : 'dark';
  } catch {
    return 'dark';
  }
}

function writeTheme(t: ThemeId): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, t);
  } catch {
    /* quota / private mode — accept silently */
  }
}

function readOverrides(): Partial<Record<TweakableToken, string>> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const out: Partial<Record<TweakableToken, string>> = {};
    for (const k of TWEAKABLE_TOKENS) {
      const v = parsed[k];
      if (isHexColor(v)) out[k] = v.toUpperCase();
    }
    return out;
  } catch {
    return {};
  }
}

function writeOverrides(o: Partial<Record<TweakableToken, string>>): void {
  try {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));
  } catch {
    /* quota / private mode — accept silently */
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readTheme(),
  overrides: readOverrides(),
  setTheme: (theme) => {
    writeTheme(theme);
    set({ theme });
  },
  setOverride: (token, hex) => {
    const next = { ...get().overrides };
    if (hex == null) {
      delete next[token];
    } else {
      if (!isHexColor(hex)) return;
      next[token] = hex.toUpperCase();
    }
    writeOverrides(next);
    set({ overrides: next });
  },
  resetOverrides: () => {
    writeOverrides({});
    set({ overrides: {} });
  },
}));
