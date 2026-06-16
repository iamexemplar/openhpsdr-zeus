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
// Zeus is an independent reimplementation in .NET — not a fork. Its
// Protocol-1 / Protocol-2 framing, WDSP integration, meter pipelines, and
// TX behaviour were informed by studying the Thetis project
// (https://github.com/ramdor/Thetis), the authoritative reference
// implementation in the OpenHPSDR ecosystem. Zeus gratefully acknowledges
// the Thetis contributors whose work made this possible:
//
//   Richard Samphire (MW0LGE), Warren Pratt (NR0V),
//   Laurence Barker (G8NJJ),   Rick Koch (N1GP),
//   Bryan Rambo (W4WMT),       Chris Codella (W2PA),
//   Doug Wigley (W5WC),        FlexRadio Systems,
//   Richard Allen (W5SD),      Joe Torrey (WD5Y),
//   Andrew Mansfield (M0YGG),  Reid Campbell (MI0BOT),
//   Sigi Jetzlsperger (DH1KLM).
//
// Thetis itself continues the GPL-governed lineage of FlexRadio PowerSDR
// and the OpenHPSDR (TAPR/OpenHPSDR) ecosystem; that lineage is preserved
// here. See ATTRIBUTIONS.md at the repository root for the full provenance
// statement and per-component attribution.
//
// Protocol-2 / PureSignal / Saturn-class behaviour was additionally informed
// by pihpsdr (https://github.com/dl1ycf/pihpsdr), maintained by Christoph
// Wüllen (DL1YCF); and by DeskHPSDR
// (https://github.com/dl1bz/deskhpsdr), maintained by Heiko (DL1BZ).
// Both are GPL-2.0-or-later.
//
// WDSP — loaded by Zeus via P/Invoke — is Copyright (C) Warren Pratt
// (NR0V), distributed under GPL v2 or later.
//
// Zeus is distributed WITHOUT ANY WARRANTY; see the GNU General Public
// License for details.

import { Repeat2 } from 'lucide-react';
import { setRx2, swapVfos, type Rx2AudioMode } from '../../api/client';
import { VfoDisplay } from '../../components/VfoDisplay';
import { useConnectionStore } from '../../state/connection-store';

const AUDIO_MODES: readonly { mode: Rx2AudioMode; label: string; title: string }[] = [
  { mode: 'both', label: 'Both', title: 'Hear RX1 and RX2 together' },
  { mode: 'rx1', label: 'RX1', title: 'Hear RX1 only' },
  { mode: 'rx2', label: 'RX2', title: 'Hear RX2 only' },
];

export function VfoPanel() {
  const applyState = useConnectionStore((s) => s.applyState);
  const vfoHz = useConnectionStore((s) => s.vfoHz);
  const rx2Enabled = useConnectionStore((s) => s.rx2Enabled);
  const rx2AudioMode = useConnectionStore((s) => s.rx2AudioMode);
  const rx2AfGainDb = useConnectionStore((s) => s.rx2AfGainDb);

  const patchRx2 = (req: {
    enabled?: boolean;
    vfoBHz?: number;
    audioMode?: Rx2AudioMode;
    afGainDb?: number;
  }) => {
    const optimistic: Partial<ReturnType<typeof useConnectionStore.getState>> = {};
    if (req.enabled !== undefined) optimistic.rx2Enabled = req.enabled;
    if (req.vfoBHz !== undefined) optimistic.vfoBHz = req.vfoBHz;
    if (req.audioMode !== undefined) optimistic.rx2AudioMode = req.audioMode;
    if (req.afGainDb !== undefined) optimistic.rx2AfGainDb = req.afGainDb;
    useConnectionStore.setState(optimistic);
    setRx2(req).then(applyState).catch(() => {});
  };

  return (
    <div className="freq-panel" style={{ flex: 1, overflow: 'auto' }}>
      <VfoDisplay receiver="A" label="VFO A" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <label className="chip" style={{ justifyContent: 'space-between' }}>
          <span className="k">RX2</span>
          <input
            type="checkbox"
            checked={rx2Enabled}
            onChange={(e) => patchRx2({ enabled: e.currentTarget.checked })}
            aria-label="Enable RX2"
          />
        </label>
        <button
          type="button"
          className="btn sm"
          onClick={() => swapVfos().then(applyState).catch(() => {})}
          title="Swap VFO A and VFO B"
          aria-label="Swap VFO A and VFO B"
        >
          <Repeat2 size={14} />
        </button>
      </div>
      <VfoDisplay receiver="B" label="VFO B" compact />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn sm"
          onClick={() => patchRx2({ vfoBHz: vfoHz })}
          title="Copy VFO A to VFO B"
        >
          A to B
        </button>
        {AUDIO_MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            className={`btn sm ${rx2AudioMode === m.mode ? 'active' : ''}`}
            disabled={!rx2Enabled}
            onClick={() => patchRx2({ audioMode: m.mode })}
            title={m.title}
          >
            {m.label}
          </button>
        ))}
      </div>
      <label
        className="chip mono"
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          gap: 8,
        }}
      >
        <span className="k">RX2 AF</span>
        <input
          type="range"
          min={-30}
          max={12}
          step={1}
          value={rx2AfGainDb}
          disabled={!rx2Enabled}
          onChange={(e) => patchRx2({ afGainDb: Number(e.currentTarget.value) })}
          aria-label="RX2 audio gain"
        />
        <span className="v">{rx2AfGainDb.toFixed(0)} dB</span>
      </label>
    </div>
  );
}
