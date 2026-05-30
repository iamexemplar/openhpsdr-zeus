// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useCwDecoderStore } from '../../state/cw-decoder-store';
import { useCwStore, type CwEngineState } from '../../state/cw-store';
import { sendCw } from '../../api/cw';

type TerminalEntry =
  | { kind: 'rx'; text: string }
  | { kind: 'tx'; text: string };

type CwTerminalProps = {
  decoderEnabled: boolean;
  onToggleDecoder: () => void;
};

export function CwTerminal({ decoderEnabled, onToggleDecoder }: CwTerminalProps) {
  const { state: decoderState, text: rxText, wpm: rxWpm, snrDb, confidence, toggleHold, clear } =
    useCwDecoderStore();
  const wpm = useCwStore((s) => s.settings.wpm);

  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const prevRxLen = useRef(0);

  // Track incoming RX text deltas and coalesce consecutive RX chunks.
  useEffect(() => {
    if (rxText.length > prevRxLen.current) {
      const delta = rxText.slice(prevRxLen.current);
      setEntries((e) => {
        const last = e[e.length - 1];
        if (last?.kind === 'rx') {
          return [...e.slice(0, -1), { kind: 'rx', text: last.text + delta }];
        }
        return [...e, { kind: 'rx', text: delta }];
      });
    } else if (rxText.length < prevRxLen.current) {
      setEntries([]);
    }
    prevRxLen.current = rxText.length;
  }, [rxText]);

  // Echo macros/engine-sent text into the terminal.
  // Track the last engine state so we only add an entry when a new send starts.
  const engineStatus = useCwStore((s) => s.status);
  const prevEngineState = useRef<CwEngineState>('idle');
  useEffect(() => {
    const { state, text } = engineStatus;
    const prev = prevEngineState.current;
    // TX starts → blank line + TX text
    if (state === 'sending' && prev !== 'sending' && text) {
      setEntries((e) => [...e, { kind: 'tx', text: '\n' + text }]);
    }
    // TX ends → blank line so next RX text starts on a fresh line
    if (prev === 'sending' && state !== 'sending') {
      setEntries((e) => {
        if (e.length === 0) return e;
        // Append the trailing newline to the last TX entry rather than
        // adding a new entry, so coalescing works correctly.
        const last = e[e.length - 1];
        if (last?.kind === 'tx') {
          return [...e.slice(0, -1), { kind: 'tx', text: last.text + '\n' }];
        }
        return [...e, { kind: 'rx', text: '\n' }];
      });
    }
    prevEngineState.current = state;
  }, [engineStatus]);

  const [txDraft, setTxDraft] = useState('');
  const windowRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(async () => {
    const text = txDraft.trim();
    if (!text) return;
    setTxDraft('');
    // Do NOT add a manual echo here — the engine status useEffect above
    // echoes the text when the backend confirms state='sending', which also
    // covers macros sent from the keyer. A manual echo here caused duplicates.
    try { await sendCw(text, wpm); } catch { /* silent */ }
  }, [txDraft, wpm]);

  useEffect(() => {
    const el = windowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const isListening = decoderState === 'listening';
  const isHeld     = decoderState === 'held';
  const isIdle     = decoderState === 'idle';
  const active     = isListening || isHeld;

  const confidenceColor =
    confidence > 0.8 ? 'var(--accent-bright)' :
    confidence > 0.5 ? 'var(--power)' :
    'var(--tx)';
  const confidenceLabel = confidence > 0.8 ? 'HI' : confidence > 0.5 ? 'MED' : 'LO';

  const stateLabel = isHeld ? 'HELD' : isListening ? 'DECODE' : 'OFF';

  return (
    <div className="cw-terminal">

      {/* Header row: state LED + label + decoder ON/OFF */}
      <div className="cw-terminal-header">
        <span className={`cw-stream-led${active ? ' cw-stream-led--active' : ''}`} aria-hidden="true" />
        <span className="cw-terminal-state-label">{stateLabel}</span>
        {active && (
          <div className="cw-terminal-stats-inline">
            <div className={`cw-terminal-stat${isListening ? ' is-active' : ''}`}>
              <span className="cw-terminal-stat-label">WPM</span>
              <span className="cw-terminal-stat-value mono">{rxWpm}</span>
            </div>
            <div className="cw-terminal-stat">
              <span className="cw-terminal-stat-label">SNR</span>
              <span className="cw-terminal-stat-value mono">{snrDb.toFixed(0)}dB</span>
            </div>
            <div className="cw-terminal-stat">
              <span
                className="cw-confidence-dot"
                style={{ background: confidenceColor, width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0 }}
                aria-label={`Confidence ${confidenceLabel}`}
              />
              <span className="cw-terminal-stat-label">{confidenceLabel}</span>
            </div>
          </div>
        )}
        <div className="cw-terminal-header-actions">
          <button
            type="button"
            className={`cw-hold${isHeld ? ' is-armed' : ''}`}
            onClick={toggleHold}
            disabled={isIdle}
            title="Hold — pause text display"
          >HOLD</button>
          <button
            type="button"
            className="cw-clear"
            onClick={() => { clear(); setEntries([]); prevRxLen.current = 0; }}
            disabled={entries.length === 0 && isIdle}
            title="Clear terminal"
          >CLEAR</button>
          <button
            type="button"
            className={`btn${decoderEnabled ? ' accent' : ''}`}
            onClick={onToggleDecoder}
            aria-label={decoderEnabled ? 'Disable decoder' : 'Enable decoder'}
          >{decoderEnabled ? 'ON' : 'OFF'}</button>
        </div>
      </div>

      {/* Scrolling decode window */}
      <div ref={windowRef} className="cw-terminal-window" role="log" aria-live="polite">
        {entries.length === 0
          ? <span className="cw-stream-placeholder">
              {decoderEnabled ? '… waiting for signal …' : '—— DECODER OFF ——'}
            </span>
          : entries.map((e, i) =>
              e.kind === 'rx'
                ? <span key={i} className="cw-terminal-rx">{e.text}</span>
                : <span key={i} className="cw-terminal-tx" title="Transmitted">{e.text} </span>
            )
        }
      </div>

      {/* TX free-text input */}
      <div className="cw-terminal-input-row">
        <span className="cw-terminal-prompt mono" aria-hidden="true">&gt;</span>
        <input
          type="text"
          className="cw-terminal-input mono"
          value={txDraft}
          onChange={(e) => setTxDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSend(); }}
          placeholder="type and Enter to transmit…"
          aria-label="CW text to transmit"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="characters"
        />
        <button
          type="button"
          className="cw-terminal-send-btn"
          onClick={() => void handleSend()}
          disabled={!txDraft.trim()}
          title="Send"
          aria-label="Send"
        >↵</button>
      </div>

    </div>
  );
}
