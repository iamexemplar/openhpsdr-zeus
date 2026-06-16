// SPDX-License-Identifier: GPL-2.0-or-later

import {
  fetchTxFidelityPolicy,
  fetchTxStationProfiles,
  type RxMode,
} from '../api/client';
import { useAudioSuiteStore } from '../state/audio-suite-store';
import { useConnectionStore } from '../state/connection-store';
import { useTxStore } from '../state/tx-store';
import { applyTxStationProfile } from './apply-tx-station-profile';
import {
  getTxStationProfile,
  isTxStationProfileId,
  mergeTxStationProfileOverrides,
  txStationProfileToDto,
  STUDIO_SSB_PROFILE,
  type TxStationProfile,
} from './tx-station-profile';

let inFlight: Promise<void> | null = null;
let lastAppliedKey = '';

function activationKey(endpoint: string | null, mode: RxMode, profile: TxStationProfile): string {
  return JSON.stringify({
    endpoint,
    mode,
    profile: txStationProfileToDto(profile),
  });
}

export function resetTxStationProfileActivation(): void {
  lastAppliedKey = '';
  inFlight = null;
}

export async function ensureTxStationProfileActivated(signal?: AbortSignal): Promise<void> {
  const connection = useConnectionStore.getState();
  if (connection.status !== 'Connected') return;
  if (inFlight) return inFlight;

  inFlight = activateTxStationProfile(signal).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function activateTxStationProfile(signal?: AbortSignal): Promise<void> {
  const [overrides, policy] = await Promise.all([
    fetchTxStationProfiles(signal),
    fetchTxFidelityPolicy(signal),
  ]);
  if (signal?.aborted) return;

  const connection = useConnectionStore.getState();
  if (connection.status !== 'Connected') return;

  const profiles = mergeTxStationProfileOverrides(overrides);
  const profileId = isTxStationProfileId(policy.profileId)
    ? policy.profileId
    : STUDIO_SSB_PROFILE.id;
  const profile = getTxStationProfile(profileId, profiles);
  const key = activationKey(connection.endpoint, connection.mode, profile);
  if (lastAppliedKey === key) return;

  const tx = useTxStore.getState();
  const audio = useAudioSuiteStore.getState();
  await applyTxStationProfile(profile, {
    mode: connection.mode,
    applyState: useConnectionStore.getState().applyState,
    hydrateTxFromState: tx.hydrateFromState,
    setMicGainDb: tx.setMicGainDb,
    setLevelerMaxGainDb: tx.setLevelerMaxGainDb,
    setCfcConfigLocal: tx.setCfcConfig,
    setAudioProcessingMode: audio.setProcessingMode,
    setAudioMasterBypassed: audio.setMasterBypassed,
    applyAudioProfile: audio.applyProfile,
    signal,
  });
  if (!signal?.aborted) lastAppliedKey = key;
}
