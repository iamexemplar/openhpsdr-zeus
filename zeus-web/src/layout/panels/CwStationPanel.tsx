// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

import { useCwStore } from '../../state/cw-store';
import { useCwDecoderStore } from '../../state/cw-decoder-store';
import { abortCw, sendCw } from '../../api/cw';
import { TileChrome } from '../TileChrome';
import { CwKeyer } from '../../components/design/CwKeyer';
import { CwTerminal } from '../../components/design/CwTerminal';
import { CwThresholdScope } from '../../components/design/CwThresholdScope';
import type { PanelComponentProps } from '../panels';

const MAX_MACROS = 32;

export function CwStationPanel({ onRemove }: PanelComponentProps) {
  const settings = useCwStore((s) => s.settings);
  const status = useCwStore((s) => s.status);
  const setSettingsLocal = useCwStore((s) => s.setSettingsLocal);
  const commitDebounced = useCwStore((s) => s.commitDebounced);
  const patchSettings = useCwStore((s) => s.patchSettings);
  const setMacro = useCwStore((s) => s.setMacro);
  const addMacro = useCwStore((s) => s.addMacro);
  const removeMacro = useCwStore((s) => s.removeMacro);

  const decoderState = useCwDecoderStore((s) => s.state);
  const setEnabled = useCwDecoderStore((s) => s.setEnabled);

  const decoderEnabled = decoderState !== 'idle';
  const handleRemove = onRemove ?? (() => {});

  return (
    <>
      <TileChrome title="CW" onRemove={handleRemove} />
      <div className="workspace-tile-body cw-station">

        {/* ── TERMINAL region ── */}
        <div className="cw-station-section cw-station-section--terminal">
          <CwTerminal
            decoderEnabled={decoderEnabled}
            onToggleDecoder={() => setEnabled(!decoderEnabled)}
          />
        </div>

        <div className="cw-station-sep" role="separator" />

        {/* ── SCOPE region ── */}
        <div className="cw-station-section cw-station-section--scope">
          <div className="cw-station-section-label">THRESHOLD SCOPE</div>
          <CwThresholdScope />
        </div>

        <div className="cw-station-sep" role="separator" />

        {/* ── KEYER region ── */}
        <div className="cw-station-section cw-station-section--keyer">
          <div className="cw-station-section-label">KEYER</div>
          <CwKeyer
            wpm={settings.wpm}
            setWpmLocal={(v) => setSettingsLocal({ wpm: v })}
            setWpmCommit={(v) => commitDebounced({ wpm: v })}
            keyerMode={settings.keyerMode}
            setKeyerMode={(m) => void patchSettings({ keyerMode: m })}
            sidetoneHz={settings.sidetoneHz}
            setSidetoneHzLocal={(v) => setSettingsLocal({ sidetoneHz: v })}
            setSidetoneHzCommit={(v) => commitDebounced({ sidetoneHz: v })}
            sidetoneGainDb={settings.sidetoneGainDb}
            setSidetoneGainDbLocal={(v) => setSettingsLocal({ sidetoneGainDb: v })}
            setSidetoneGainDbCommit={(v) => commitDebounced({ sidetoneGainDb: v })}
            macros={settings.macros}
            onSend={(macro) => void sendCw(macro, settings.wpm)}
            onAbort={() => void abortCw()}
            onMacroEdit={(i, v) => void setMacro(i, v)}
            onMacroDelete={(i) => void removeMacro(i)}
            onMacroAdd={() => void addMacro()}
            maxMacros={MAX_MACROS}
            status={status}
          />
        </div>

      </div>
    </>
  );
}
