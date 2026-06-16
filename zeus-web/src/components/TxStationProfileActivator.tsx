// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect } from 'react';
import {
  ensureTxStationProfileActivated,
  resetTxStationProfileActivation,
} from '../audio/tx-station-profile-activation';
import { useConnectionStore } from '../state/connection-store';

export function TxStationProfileActivator() {
  const status = useConnectionStore((s) => s.status);
  const endpoint = useConnectionStore((s) => s.endpoint);
  const mode = useConnectionStore((s) => s.mode);

  useEffect(() => {
    if (status !== 'Connected') {
      resetTxStationProfileActivation();
      return;
    }
    let active = true;
    void ensureTxStationProfileActivated().catch((err) => {
      if (active) {
        console.warn('tx station profile activation failed', err);
      }
    });
    return () => {
      active = false;
    };
  }, [endpoint, mode, status]);

  return null;
}
