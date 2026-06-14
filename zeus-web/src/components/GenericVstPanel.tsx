// SPDX-License-Identifier: GPL-2.0-or-later
//
// GenericVstPanel — the rack body for a plugin that ships no UI module
// of its own, i.e. a VST3 registered via "Add VST directory". The host
// can't (yet) introspect a .vst3's parameters or open its native editor
// from the browser — that needs native-bridge entry points + desktop
// (Photino) mode. So for now this panel just identifies the plugin and
// explains where its controls will live. Reorder / park / remove still
// work from the rack slot chrome, and the VST still processes audio.

interface GenericVstPanelProps {
  pluginId: string;
  name: string;
}

export function GenericVstPanel({ pluginId, name }: GenericVstPanelProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 11,
        color: 'var(--fg-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 1,
            color: 'var(--fg-0)',
            background: 'var(--bg-2)',
            border: '1px solid var(--line-1)',
            borderRadius: 3,
            padding: '1px 5px',
          }}
        >
          VST3
        </span>
        <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{name}</span>
      </div>
      <p style={{ margin: 0, lineHeight: 1.4, color: 'var(--fg-3)' }}>
        Scanned VST — it processes audio in the chain. Its native editor and
        parameter controls open in the desktop app (coming in a later build);
        in the browser this slot shows status only.
      </p>
      <code
        style={{
          fontSize: 9.5,
          color: 'var(--fg-3)',
          fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
          wordBreak: 'break-all',
        }}
      >
        {pluginId}
      </code>
    </div>
  );
}
