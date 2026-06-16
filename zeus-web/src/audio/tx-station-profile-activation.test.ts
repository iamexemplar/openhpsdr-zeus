// SPDX-License-Identifier: GPL-2.0-or-later

/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DX_PROFILE, txStationProfileToDto } from './tx-station-profile';
import { useAudioSuiteStore } from '../state/audio-suite-store';
import { useConnectionStore } from '../state/connection-store';
import { useTxStore } from '../state/tx-store';
import {
  ensureTxStationProfileActivated,
  resetTxStationProfileActivation,
} from './tx-station-profile-activation';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type RadioStateProfile = Pick<
  typeof DX_PROFILE,
  | 'micGainDb'
  | 'levelerMaxGainDb'
  | 'txLeveling'
  | 'lowCutHz'
  | 'highCutHz'
  | 'cfcConfig'
>;

function radioStateForProfile(profile: RadioStateProfile = DX_PROFILE): Record<string, unknown> {
  return {
    status: 'Connected',
    endpoint: '192.168.1.20:1024',
    mode: 'USB',
    micGainDb: profile.micGainDb,
    levelerMaxGainDb: profile.levelerMaxGainDb,
    txLeveling: profile.txLeveling,
    txFilterLowHz: profile.lowCutHz,
    txFilterHighHz: profile.highCutHz,
    cfc: profile.cfcConfig,
    drivePct: 0,
    tunePct: 10,
  };
}

describe('tx-station-profile activation', () => {
  beforeEach(() => {
    resetTxStationProfileActivation();
    useConnectionStore.setState({
      status: 'Connected',
      endpoint: '192.168.1.20:1024',
      mode: 'USB',
    });
    useTxStore.setState({
      micGainDb: 0,
      levelerMaxGainDb: 8,
    });
    useAudioSuiteStore.setState({
      processingMode: 'native',
      vstEngineAvailable: false,
      vstEngineActive: false,
      masterBypassed: true,
      selectedProfile: '',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetTxStationProfileActivation();
  });

  it('applies the persisted station profile without a mounted TX profile panel', async () => {
    const dx = txStationProfileToDto({
      ...DX_PROFILE,
      audioSuiteProfileName: 'ESSB Broadcast',
    });
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/tx/station-profiles') {
        return jsonResponse({ profiles: [dx] });
      }
      if (url === '/api/tx/fidelity-policy') {
        return jsonResponse({ profileId: 'dx', targetSpectralDensity: 100 });
      }
      if (url === '/api/audio-suite/profiles/ESSB%20Broadcast/apply') {
        return jsonResponse({
          pluginIds: ['com.openhpsdr.zeus.samples.compressor'],
          processingMode: 'vst',
          engineAvailable: true,
          engineActive: true,
          masterBypass: false,
        });
      }
      if (url === '/api/mic-gain') {
        return jsonResponse({ micGainDb: -2 });
      }
      if (url === '/api/tx/leveler-max-gain') {
        return jsonResponse({ levelerMaxGainDb: 12 });
      }
      if (url === '/api/tx/leveling' || url === '/api/tx-filter' || url === '/api/tx/cfc') {
        return jsonResponse(radioStateForProfile(dx));
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await ensureTxStationProfileActivated();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain('/api/audio-suite/profiles/ESSB%20Broadcast/apply');
    expect(urls).toContain('/api/mic-gain');
    expect(urls).toContain('/api/tx/leveler-max-gain');
    expect(urls).toContain('/api/tx/leveling');
    expect(urls).toContain('/api/tx-filter');
    expect(urls).toContain('/api/tx/cfc');
    expect(useTxStore.getState().micGainDb).toBe(-2);
    expect(useTxStore.getState().levelerMaxGainDb).toBe(12);
  });

  it('reuses the activation result for repeated key-down preflights', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/tx/station-profiles') return jsonResponse({ profiles: [] });
      if (url === '/api/tx/fidelity-policy') {
        return jsonResponse({ profileId: 'dx', targetSpectralDensity: 100 });
      }
      if (url === '/api/audio-suite/processing-mode') {
        return jsonResponse({ mode: 'vst', engineAvailable: true, engineActive: true });
      }
      if (url === '/api/audio-suite/master-bypass') {
        return jsonResponse({ bypassed: false });
      }
      if (url === '/api/mic-gain') return jsonResponse({ micGainDb: -2 });
      if (url === '/api/tx/leveler-max-gain') return jsonResponse({ levelerMaxGainDb: 12 });
      if (url === '/api/tx/leveling' || url === '/api/tx-filter' || url === '/api/tx/cfc') {
        return jsonResponse(radioStateForProfile(DX_PROFILE));
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await ensureTxStationProfileActivated();
    await ensureTxStationProfileActivated();

    const routePuts = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input) === '/api/audio-suite/processing-mode' &&
        init?.method === 'PUT',
    );
    expect(routePuts).toHaveLength(1);
  });
});
