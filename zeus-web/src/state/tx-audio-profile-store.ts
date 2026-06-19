// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF),
//                         Douglas J. Cerrato (KB2UKA), and contributors.
//
// Unified TX Audio Profile store. A TX Audio Profile is a single operator-named
// macro that captures the ENTIRE TX audio-shaping state (mic/leveler scalars,
// TxLeveling + CFC configs, TX bandpass, the Audio Suite chain + every plugin's
// settings, and the fidelity spectral-density target). It REPLACES both the old
// fixed-3 station profiles and the TX audio-suite named profiles.
//
// Single source of truth: the BACKEND. The frontend never assembles a profile
// body — Save sends only a name and the server snapshots live state. Apply
// returns a full StateDto that drives the live UI. At startup the frontend loads
// the LIST + last-loaded pointer ONLY (for the dropdown); the backend already
// applied last-loaded before connect, so live values may have drifted from the
// selected profile — that is intended (live edits are transient vs the profile).

import { create } from 'zustand';

import {
  applyTxAudioProfile,
  deleteTxAudioProfile,
  fetchLastLoadedTxAudioProfile,
  fetchTxAudioProfiles,
  saveTxAudioProfile,
  type TxAudioProfileDto,
} from '../api/client';
import { useAudioSuiteStore } from './audio-suite-store';
import { useConnectionStore } from './connection-store';
import { useTxStore } from './tx-store';

export interface TxAudioProfileMutationResult {
  ok: boolean;
  error?: string;
}

interface TxAudioProfileState {
  profiles: TxAudioProfileDto[];
  loaded: boolean;
  /** The persisted "last loaded" pointer; what the dropdown shows as selected. */
  lastLoadedId: string | null;
  busy: boolean;

  /** Load the profile list + last-loaded pointer (dropdown only — does NOT apply). */
  load(): Promise<void>;
  /** Snapshot the LIVE state as a profile named <name>; sends only the name. */
  save(name: string): Promise<TxAudioProfileMutationResult>;
  /** Apply a profile by id to LIVE state; drives the live UI from the response. */
  apply(id: string): Promise<TxAudioProfileMutationResult>;
  /** Delete a profile by id. */
  remove(id: string): Promise<TxAudioProfileMutationResult>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useTxAudioProfileStore = create<TxAudioProfileState>((set, get) => ({
  profiles: [],
  loaded: false,
  lastLoadedId: null,
  busy: false,

  load: async () => {
    try {
      const [profiles, lastLoaded] = await Promise.all([
        fetchTxAudioProfiles(),
        fetchLastLoadedTxAudioProfile(),
      ]);
      set({ profiles, lastLoadedId: lastLoaded.id, loaded: true });
    } catch (err) {
      console.warn('tx-audio-profiles load threw', err);
      // Keep whatever we had; mark loaded so the UI shows an empty/last state
      // rather than spinning forever.
      set({ loaded: true });
    }
  },

  save: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Profile name is required.' };
    if (get().busy) return { ok: false, error: 'Busy.' };
    set({ busy: true });
    try {
      const saved = await saveTxAudioProfile(trimmed);
      // Saving captures the live state but does NOT change which profile is the
      // last-loaded selection — only an explicit apply does that. Refresh the
      // list so the new/overwritten row appears.
      await get().load();
      set({ busy: false });
      // Defensive: ensure the saved row is present even if the reload raced.
      if (!get().profiles.some((p) => p.id === saved.id)) {
        set((s) => ({ profiles: [...s.profiles, saved].sort((a, b) => a.id.localeCompare(b.id)) }));
      }
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      return { ok: false, error: errorText(err) };
    }
  },

  apply: async (id) => {
    const trimmed = id.trim().toLowerCase();
    if (!trimmed) return { ok: false, error: 'Profile id is required.' };
    if (get().busy) return { ok: false, error: 'Busy.' };
    set({ busy: true });
    try {
      const result = await applyTxAudioProfile(trimmed);

      // Drive the live UI from the returned StateDto — same body the existing
      // reconcilers parse (mic/leveler/cfc/filter all live in StateDto).
      const conn = useConnectionStore.getState();
      const tx = useTxStore.getState();
      conn.applyState(result.state);
      tx.hydrateFromState(result.state);

      // Reconcile the Audio Suite chain/mode/bypass from the apply response, then
      // resync the full chain order + parked set from the server so the rack UI
      // (and any open Audio Suite window) reflects the applied chain.
      const audio = useAudioSuiteStore.getState();
      useAudioSuiteStore.setState({
        chainOrder: result.pluginIds,
        processingMode: result.processingMode,
        masterBypassed: result.masterBypass,
        vstEngineActive: result.engineActive,
        vstEngineAvailable: result.engineAvailable,
      });
      await audio.loadChainOrderFromServer();

      set({ lastLoadedId: trimmed, busy: false });
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      return { ok: false, error: errorText(err) };
    }
  },

  remove: async (id) => {
    const trimmed = id.trim().toLowerCase();
    if (!trimmed) return { ok: false, error: 'Profile id is required.' };
    if (get().busy) return { ok: false, error: 'Busy.' };
    set({ busy: true });
    try {
      await deleteTxAudioProfile(trimmed);
      set((s) => ({
        profiles: s.profiles.filter((p) => p.id !== trimmed),
        // Clearing the dropdown selection if we just removed the selected one is
        // a UI nicety; the backend keeps its own last-loaded pointer.
        lastLoadedId: s.lastLoadedId === trimmed ? null : s.lastLoadedId,
        busy: false,
      }));
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      return { ok: false, error: errorText(err) };
    }
  },
}));
