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
// RF2K-S amplifier wire format. The amp ships an in-firmware Bottle/Python
// REST API on TCP/8080 (no auth) — see CT1IQI/RF2K-S
// `g_firmware/world_server/rf-kit-gui_v159/rest_server/restServer.py`.
// Most measurement endpoints wrap values as `{value, unit}` and forward/
// reflected/swr add `max_value` for the firmware's peak hold. We mirror
// the wire shape directly here so the Rf2kService can deserialise without
// translation; the panel layer flattens to plain numbers for display.

namespace Zeus.Contracts;

// ============================================================================
//  Configuration / persistence
// ============================================================================

public sealed record Rf2kConfig(
    bool Enabled = false,
    string Host = "10.70.120.41",
    int Port = 8080,
    int VncPort = 5900,
    // VNC password (RFB security type 2). Empty = try "None" auth (type 1)
    // first; required if the amp's vncserver requires a password (which
    // most do by default — including the RF2K-S firmware). Limited to 8
    // characters by the RFB password protocol; longer values are
    // truncated. Stored unencrypted in zeus-prefs.db; treat as low-value
    // shared-LAN credential, not a sensitive secret.
    string VncPassword = "",
    int PollingIntervalMs = 500,
    // Tune and Bypass click coordinates on the amp's 1024x600 panel.
    // The amp's UI uses Tk's dynamic grid so there are no static coordinates
    // in the firmware — the operator calibrates these once via the panel's
    // "Calibrate" workflow (a Test Click button that sends one click at any
    // X/Y) and saves the values that hit the Tune and Bypass buttons.
    // 0/0 means "unconfigured" — the corresponding panel button stays
    // disabled until the user provides coordinates.
    int TuneClickX = 0,
    int TuneClickY = 0,
    int BypassClickX = 0,
    int BypassClickY = 0);

// ============================================================================
//  Wire-shape DTOs (deserialised straight from the amp's REST API)
// ============================================================================

/// <summary>Wraps a measurement: `{"value": 53.0, "unit": "V"}` etc.</summary>
public sealed record Rf2kReading(double Value, string? Unit);

/// <summary>Forward/reflected/SWR reading with peak hold (`max_value`).</summary>
public sealed record Rf2kPeakReading(double Value, double MaxValue, string? Unit);

/// <summary>GET /info — `{"device": "RF2K-S", "software_version": {...}, "custom_device_name": "..."}`.</summary>
public sealed record Rf2kInfo(string? Device, Rf2kSoftwareVersion? SoftwareVersion, string? CustomDeviceName);

public sealed record Rf2kSoftwareVersion(int? Gui, int? Controller);

/// <summary>GET /data — `{"band": {value, unit}, "frequency": {value, unit}, "status": ""}`.</summary>
public sealed record Rf2kData(Rf2kReading? Band, Rf2kReading? Frequency, string? Status);

/// <summary>GET /power — temp/voltage/current + forward/reflected/swr peak readings.</summary>
public sealed record Rf2kPower(
    Rf2kReading? Temperature,
    Rf2kReading? Voltage,
    Rf2kReading? Current,
    Rf2kPeakReading? Forward,
    Rf2kPeakReading? Reflected,
    Rf2kPeakReading? Swr);

/// <summary>GET /tuner — `{"mode": "OFF" | "BYPASS" | "AUTO" | …}` plus optional L/C when tuned.</summary>
public sealed record Rf2kTuner(string? Mode, string? Setup, double? L, double? C, double? TunedFrequency);

public sealed record Rf2kOperateMode(string OperateMode);

public sealed record Rf2kOperationalInterface(string OperationalInterface, string? Error);

public sealed record Rf2kAntenna(string? Type, int? Number, string? State);

public sealed record Rf2kAntennaList(IReadOnlyList<Rf2kAntenna> Antennas);

public sealed record Rf2kActiveAntenna(string? Type, int? Number);

// ============================================================================
//  Request DTOs from the frontend
// ============================================================================

public sealed record Rf2kSetOperateRequest(string Mode);  // "OPERATE" or "STANDBY"

public sealed record Rf2kSetInterfaceRequest(string Interface);  // UNIV/CAT/UDP/TCI

public sealed record Rf2kSetAntennaRequest(string Type, int? Number);

public sealed record Rf2kTestRequest(string Host, int Port);

public sealed record Rf2kClickRequest(int X, int Y);

// ============================================================================
//  Aggregate panel snapshot (single fetch from frontend)
// ============================================================================

public sealed record Rf2kStatus(
    bool Enabled,
    bool Connected,
    string Host,
    int Port,
    Rf2kInfo? Info,
    Rf2kData? Data,
    Rf2kPower? Power,
    Rf2kTuner? Tuner,
    string? OperateMode,                     // "OPERATE" / "STANDBY" / null
    string? OperationalInterface,            // "UNIV" / "CAT" / "UDP" / "TCI" / null
    string? OperationalInterfaceError,       // e.g. "No TCI available"
    Rf2kActiveAntenna? ActiveAntenna,
    IReadOnlyList<Rf2kAntenna>? Antennas,
    string? Error,                            // last failure that prevented a poll/command
    DateTimeOffset? LastSampleUtc);           // when the most recent successful poll completed

public sealed record Rf2kTestResult(bool Ok, string? Error);
