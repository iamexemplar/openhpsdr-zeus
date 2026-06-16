// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setCfcConfig,
  setLevelerMaxGain,
  setMicGain,
  setTxFilter,
  setTxLeveling,
  type RadioStateDto,
} from '../api/client';
import { applyTxStationProfile, type ApplyTxStationProfileDeps } from './apply-tx-station-profile';
import { DX_PROFILE, ESSB_PROFILE } from './tx-station-profile';

vi.mock('../api/client', () => ({
  setMicGain: vi.fn(async (db: number) => ({ micGainDb: db })),
  setLevelerMaxGain: vi.fn(async (gain: number) => ({ levelerMaxGainDb: gain })),
  setTxLeveling: vi.fn(async () => ({ status: 'Connected', mode: 'USB' })),
  setTxFilter: vi.fn(async () => ({ status: 'Connected', mode: 'USB' })),
  setCfcConfig: vi.fn(async (config) => ({
    status: 'Connected',
    mode: 'USB',
    cfc: config,
  })),
}));

function deps(): ApplyTxStationProfileDeps {
  return {
    mode: 'USB',
    applyState: vi.fn(),
    hydrateTxFromState: vi.fn(),
    setMicGainDb: vi.fn(),
    setLevelerMaxGainDb: vi.fn(),
    setCfcConfigLocal: vi.fn(),
    setAudioProcessingMode: vi.fn(async () => undefined),
    setAudioMasterBypassed: vi.fn(async () => undefined),
    applyAudioProfile: vi.fn(async () => ({ ok: true })),
  };
}

describe('applyTxStationProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies route and master-bypass intent when no chain profile is bound', async () => {
    const d = deps();

    await applyTxStationProfile(DX_PROFILE, d);

    expect(d.applyAudioProfile).not.toHaveBeenCalled();
    expect(d.setAudioProcessingMode).toHaveBeenCalledWith('vst');
    expect(d.setAudioMasterBypassed).toHaveBeenCalledWith(false);
    expect(setMicGain).toHaveBeenCalledWith(DX_PROFILE.micGainDb, undefined);
    expect(setLevelerMaxGain).toHaveBeenCalledWith(
      DX_PROFILE.levelerMaxGainDb,
      undefined,
    );
    expect(setTxLeveling).toHaveBeenCalledWith(DX_PROFILE.txLeveling, undefined);
    expect(setTxFilter).toHaveBeenCalledWith(300, 2850, undefined);
    expect(setCfcConfig).toHaveBeenCalled();
  });

  it('lets a named Audio Suite profile own route and bypass restore', async () => {
    const d = deps();
    const profile = {
      ...ESSB_PROFILE,
      audioSuiteProfileName: 'ESSB Broadcast',
      audioSuiteRoute: 'native' as const,
      audioSuiteBypassed: true,
    };

    await applyTxStationProfile(profile, d);

    expect(d.applyAudioProfile).toHaveBeenCalledWith('ESSB Broadcast');
    expect(d.setAudioProcessingMode).not.toHaveBeenCalled();
    expect(d.setAudioMasterBypassed).not.toHaveBeenCalled();
  });

  it('hydrates local TX stores from the server responses', async () => {
    const d = deps();
    const state = { status: 'Connected', mode: 'USB' } as RadioStateDto;
    vi.mocked(setTxLeveling).mockResolvedValueOnce(state);
    vi.mocked(setTxFilter).mockResolvedValueOnce(state);
    vi.mocked(setCfcConfig).mockResolvedValueOnce({
      ...state,
      cfc: DX_PROFILE.cfcConfig,
    });

    await applyTxStationProfile(DX_PROFILE, d);

    expect(d.applyState).toHaveBeenCalledWith(state);
    expect(d.hydrateTxFromState).toHaveBeenCalledWith(state);
    expect(d.setCfcConfigLocal).toHaveBeenCalledWith(DX_PROFILE.cfcConfig);
  });
});
