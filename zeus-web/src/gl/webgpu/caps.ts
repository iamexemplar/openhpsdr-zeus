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
// Zeus is distributed WITHOUT ANY WARRANTY; see the GNU General Public
// License for details.

// WebGPU capability probe. The heightfield waterfall only runs when this
// resolves `supported: true`; otherwise the caller falls back to WebGL2
// (gl/waterfall.ts) — same defensive posture as the #629 floatLinear fallback,
// because not every WebView2 / GPU / driver combo ships WebGPU yet.

export type WebGpuProbe = {
  supported: boolean;
  /** Human-readable reason — logged and surfaced on-screen (no DevTools in the
   *  desktop WebView2 app, per #629). */
  reason: string;
  /** The acquired device, when supported. The renderer reuses it. */
  device: GPUDevice | null;
  /** Preferred swap-chain format for the canvas context. */
  format: GPUTextureFormat;
  /** Adapter description, for the diagnostic badge. */
  adapter: string;
};

function unsupported(reason: string): WebGpuProbe {
  return { supported: false, reason, device: null, format: 'bgra8unorm', adapter: 'none' };
}

let cached: Promise<WebGpuProbe> | null = null;

/** Probe (once) for a usable WebGPU device. Cached: repeated mounts reuse the
 *  same device rather than requesting a new one each time. */
export function probeWebGpu(): Promise<WebGpuProbe> {
  if (cached) return cached;
  cached = probeWebGpuUncached();
  return cached;
}

async function probeWebGpuUncached(): Promise<WebGpuProbe> {
  try {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
      return unsupported('navigator.gpu unavailable');
    }
    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return unsupported('requestAdapter returned null');

    const device = await adapter.requestDevice();
    if (!device) return unsupported('requestDevice returned null');

    // r32float must be at least sampleable so the vertex shader can read the
    // history texture; this is core WebGPU, but probe defensively.
    const format = gpu.getPreferredCanvasFormat();
    let adapterName = 'webgpu';
    try {
      // info is widely available; guard so an old build doesn't throw.
      const info = (adapter as unknown as { info?: { vendor?: string; architecture?: string } }).info;
      if (info) adapterName = [info.vendor, info.architecture].filter(Boolean).join(' ') || 'webgpu';
    } catch {
      // adapter.info absent — keep the generic name.
    }

    return { supported: true, reason: 'ok', device, format, adapter: adapterName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unsupported(`probe threw: ${message}`);
  }
}

/** Drop the cached probe (e.g. on device loss) so the next call re-acquires. */
export function resetWebGpuProbe(): void {
  cached = null;
}
