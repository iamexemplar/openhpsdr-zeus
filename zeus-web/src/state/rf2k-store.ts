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
// See ATTRIBUTIONS.md at the repository root for the full provenance
// statement and per-component attribution.
//
// Zustand store for the RF2K-S amp panel. Backend persists config to
// LiteDB (Rf2kSettingsStore) so we don't need localStorage — initial
// load reads /api/rf2k/config, subsequent reads poll /api/rf2k/status.

import { create } from 'zustand';
import {
  bypassRf2k,
  clickRf2k,
  getRf2kConfig,
  getRf2kStatus,
  postRf2kConfig,
  resetRf2kError,
  setRf2kAntenna,
  setRf2kInterface,
  setRf2kOperate,
  testRf2k,
  tuneRf2k,
  type Rf2kConfig,
  type Rf2kStatus,
  type Rf2kTestResult,
} from '../api/rf2k';

const DEFAULT_CONFIG: Rf2kConfig = {
  enabled: false,
  host: '10.70.120.41',
  port: 8080,
  vncPort: 5900,
  vncPassword: '',
  pollingIntervalMs: 1000,
  tuneClickX: 0,
  tuneClickY: 0,
  bypassClickX: 0,
  bypassClickY: 0,
};

export type Rf2kStoreState = {
  config: Rf2kConfig;
  status: Rf2kStatus | null;
  testInFlight: boolean;
  lastTestResult: Rf2kTestResult | null;
  lastClickResult: Rf2kTestResult | null;
  configLoaded: boolean;

  loadConfig: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  saveConfig: (cfg: Rf2kConfig) => Promise<Rf2kStatus>;
  setOperate: (mode: 'OPERATE' | 'STANDBY') => Promise<void>;
  setInterface: (iface: 'UNIV' | 'CAT' | 'UDP' | 'TCI') => Promise<void>;
  setAntenna: (type: 'INTERNAL' | 'EXTERNAL', number: number | null) => Promise<void>;
  reset: () => Promise<void>;
  tune: () => Promise<Rf2kTestResult>;
  bypass: () => Promise<Rf2kTestResult>;
  test: (host: string, port: number) => Promise<Rf2kTestResult>;
  click: (x: number, y: number) => Promise<Rf2kTestResult>;
};

export const useRf2kStore = create<Rf2kStoreState>((set) => ({
  config: DEFAULT_CONFIG,
  status: null,
  testInFlight: false,
  lastTestResult: null,
  lastClickResult: null,
  configLoaded: false,

  loadConfig: async () => {
    try {
      const cfg = await getRf2kConfig();
      // Backend may return partial fields if upgraded mid-version — merge
      // over defaults so we never end up with undefined in numeric inputs.
      set({ config: { ...DEFAULT_CONFIG, ...cfg }, configLoaded: true });
    } catch {
      set({ configLoaded: true });
    }
  },

  refreshStatus: async () => {
    try {
      const status = await getRf2kStatus();
      set({ status });
    } catch {
      /* transient — next poll recovers */
    }
  },

  saveConfig: async (cfg) => {
    const status = await postRf2kConfig(cfg);
    set({ config: cfg, status });
    return status;
  },

  setOperate: async (mode) => {
    try {
      const status = await setRf2kOperate(mode);
      set({ status });
    } catch {
      /* transient */
    }
  },

  setInterface: async (iface) => {
    try {
      const status = await setRf2kInterface(iface);
      set({ status });
    } catch {
      /* transient */
    }
  },

  setAntenna: async (type, number) => {
    try {
      const status = await setRf2kAntenna(type, number);
      set({ status });
    } catch {
      /* transient */
    }
  },

  reset: async () => {
    try {
      const status = await resetRf2kError();
      set({ status });
    } catch {
      /* ignore */
    }
  },

  tune: async () => {
    const result = await tuneRf2k();
    set({ lastClickResult: result });
    return result;
  },

  bypass: async () => {
    const result = await bypassRf2k();
    set({ lastClickResult: result });
    return result;
  },

  test: async (host, port) => {
    set({ testInFlight: true, lastTestResult: null });
    const result = await testRf2k(host, port);
    set({ testInFlight: false, lastTestResult: result });
    return result;
  },

  click: async (x, y) => {
    const result = await clickRf2k(x, y);
    set({ lastClickResult: result });
    return result;
  },
}));

// Module-load: pull persisted config, then start the status-poll loop.
// Poll only when enabled — idle when disabled to avoid an HTTP heartbeat
// the user can't see anyway.
if (typeof window !== 'undefined') {
  void useRf2kStore.getState().loadConfig().then(() => {
    void useRf2kStore.getState().refreshStatus();
  });
  window.setInterval(() => {
    if (!useRf2kStore.getState().config.enabled) return;
    void useRf2kStore.getState().refreshStatus();
  }, 1000);
}
