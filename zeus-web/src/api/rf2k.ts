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
// See ATTRIBUTIONS.md at the repository root for the full provenance
// statement and per-component attribution.
//
// REST client for the RF2K-S amplifier service. Mirrors api/rotator.ts shape.
// All request/response types are camelCase — ASP.NET Core serialises C#
// PascalCase to camelCase by default, and the inner amp wire shapes
// (snake_case) are translated by the backend before reaching us.

import { ApiError } from './client';

// ============================================================================
//  Types
// ============================================================================

export type Rf2kReading = { value: number; unit: string | null };
export type Rf2kPeakReading = { value: number; maxValue: number; unit: string | null };

export type Rf2kInfo = {
  device: string | null;
  softwareVersion: { gui: number | null; controller: number | null } | null;
  customDeviceName: string | null;
};

export type Rf2kData = {
  band: Rf2kReading | null;
  frequency: Rf2kReading | null;
  status: string | null;
};

export type Rf2kPower = {
  temperature: Rf2kReading | null;
  voltage: Rf2kReading | null;
  current: Rf2kReading | null;
  forward: Rf2kPeakReading | null;
  reflected: Rf2kPeakReading | null;
  swr: Rf2kPeakReading | null;
};

export type Rf2kTuner = {
  mode: string | null;
  setup: string | null;
  l: number | null;
  c: number | null;
  tunedFrequency: number | null;
};

export type Rf2kAntenna = {
  type: string | null;
  number: number | null;
  state: string | null;
};

export type Rf2kActiveAntenna = {
  type: string | null;
  number: number | null;
};

export type Rf2kStatus = {
  enabled: boolean;
  connected: boolean;
  host: string;
  port: number;
  info: Rf2kInfo | null;
  data: Rf2kData | null;
  power: Rf2kPower | null;
  tuner: Rf2kTuner | null;
  operateMode: string | null;          // 'OPERATE' | 'STANDBY' | null
  operationalInterface: string | null; // 'UNIV' | 'CAT' | 'UDP' | 'TCI' | null
  operationalInterfaceError: string | null;
  activeAntenna: Rf2kActiveAntenna | null;
  antennas: Rf2kAntenna[] | null;
  error: string | null;
  lastSampleUtc: string | null;
};

export type Rf2kConfig = {
  enabled: boolean;
  host: string;
  port: number;
  vncPort: number;
  vncPassword: string;
  pollingIntervalMs: number;
  tuneClickX: number;
  tuneClickY: number;
  bypassClickX: number;
  bypassClickY: number;
};

export type Rf2kTestResult = { ok: boolean; error: string | null };

// ============================================================================
//  Internal helpers
// ============================================================================

async function jsonFetch<T>(
  input: RequestInfo,
  init: RequestInit | undefined,
  parse: (raw: unknown) => T,
): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as unknown;
      if (
        body &&
        typeof body === 'object' &&
        'error' in body &&
        typeof (body as { error: unknown }).error === 'string'
      ) {
        message = (body as { error: string }).error;
      }
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, message);
  }
  return parse((await res.json()) as unknown);
}

// We pass the server's raw JSON through unchanged for the deeply-nested
// status payload — defensive normalisation across all shapes would be
// thousands of lines and the server's contract is stable. Top-level boolean
// coercion only.
function asStatus(raw: unknown): Rf2kStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: Boolean(r.enabled),
    connected: Boolean(r.connected),
    host: typeof r.host === 'string' ? r.host : '',
    port: typeof r.port === 'number' ? r.port : 0,
    info: (r.info ?? null) as Rf2kInfo | null,
    data: (r.data ?? null) as Rf2kData | null,
    power: (r.power ?? null) as Rf2kPower | null,
    tuner: (r.tuner ?? null) as Rf2kTuner | null,
    operateMode: typeof r.operateMode === 'string' ? r.operateMode : null,
    operationalInterface:
      typeof r.operationalInterface === 'string' ? r.operationalInterface : null,
    operationalInterfaceError:
      typeof r.operationalInterfaceError === 'string' && r.operationalInterfaceError
        ? r.operationalInterfaceError
        : null,
    activeAntenna: (r.activeAntenna ?? null) as Rf2kActiveAntenna | null,
    antennas: Array.isArray(r.antennas) ? (r.antennas as Rf2kAntenna[]) : null,
    error: typeof r.error === 'string' && r.error ? r.error : null,
    lastSampleUtc: typeof r.lastSampleUtc === 'string' ? r.lastSampleUtc : null,
  };
}

function asTestResult(raw: unknown): Rf2kTestResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ok: Boolean(r.ok),
    error: typeof r.error === 'string' && r.error ? r.error : null,
  };
}

// ============================================================================
//  Public API
// ============================================================================

export function getRf2kStatus(signal?: AbortSignal): Promise<Rf2kStatus> {
  return jsonFetch('/api/rf2k/status', { signal }, asStatus);
}

export function getRf2kConfig(signal?: AbortSignal): Promise<Rf2kConfig> {
  return jsonFetch('/api/rf2k/config', { signal }, (raw) => raw as Rf2kConfig);
}

export function postRf2kConfig(cfg: Rf2kConfig, signal?: AbortSignal): Promise<Rf2kStatus> {
  return jsonFetch(
    '/api/rf2k/config',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
      signal,
    },
    asStatus,
  );
}

export function setRf2kOperate(mode: 'OPERATE' | 'STANDBY', signal?: AbortSignal): Promise<Rf2kStatus> {
  return jsonFetch(
    '/api/rf2k/operate',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
      signal,
    },
    asStatus,
  );
}

export function setRf2kInterface(
  iface: 'UNIV' | 'CAT' | 'UDP' | 'TCI',
  signal?: AbortSignal,
): Promise<Rf2kStatus> {
  return jsonFetch(
    '/api/rf2k/interface',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interface: iface }),
      signal,
    },
    asStatus,
  );
}

export function setRf2kAntenna(
  type: 'INTERNAL' | 'EXTERNAL',
  number: number | null,
  signal?: AbortSignal,
): Promise<Rf2kStatus> {
  return jsonFetch(
    '/api/rf2k/antenna',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, number }),
      signal,
    },
    asStatus,
  );
}

export function resetRf2kError(signal?: AbortSignal): Promise<Rf2kStatus> {
  return jsonFetch('/api/rf2k/reset', { method: 'POST', signal }, asStatus);
}

export function testRf2k(host: string, port: number, signal?: AbortSignal): Promise<Rf2kTestResult> {
  return jsonFetch(
    '/api/rf2k/test',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, port }),
      signal,
    },
    asTestResult,
  );
}

export function tuneRf2k(signal?: AbortSignal): Promise<Rf2kTestResult> {
  return jsonFetch('/api/rf2k/tune', { method: 'POST', signal }, asTestResult);
}

export function bypassRf2k(signal?: AbortSignal): Promise<Rf2kTestResult> {
  return jsonFetch('/api/rf2k/bypass', { method: 'POST', signal }, asTestResult);
}

export function clickRf2k(x: number, y: number, signal?: AbortSignal): Promise<Rf2kTestResult> {
  return jsonFetch(
    '/api/rf2k/click',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x, y }),
      signal,
    },
    asTestResult,
  );
}
