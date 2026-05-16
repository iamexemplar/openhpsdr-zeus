// SPDX-License-Identifier: GPL-2.0-or-later
using Zeus.Contracts;

namespace Zeus.Server;

/// <summary>
/// Receives demodulated audio frames produced by DspPipelineService.Tick.
/// Both the regular RX path and the TX-monitor path publish through this
/// seam, so an implementation handles whatever audio reaches the operator's
/// speakers.
///
/// Default registration is <see cref="WebSocketAudioSink"/>, which fans out
/// to connected WS clients via <c>StreamingHub.Broadcast(in AudioFrame)</c>.
/// Desktop mode swaps in a native miniaudio sink in place of the WebSocket
/// fan-out (Phase 2b).
///
/// Publish runs on the DSP tick thread and must not block or allocate
/// beyond what the existing Broadcast already does — see
/// <c>StreamingHub.Broadcast(in AudioFrame)</c> for the cost model.
/// </summary>
public interface IRxAudioSink
{
    void Publish(in AudioFrame frame);
}
