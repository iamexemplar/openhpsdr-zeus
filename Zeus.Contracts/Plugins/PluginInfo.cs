// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
//
// See ATTRIBUTIONS.md at the repository root for the full provenance
// statement and per-component attribution.

namespace Zeus.Contracts.Plugins;

/// <summary>
/// Wire-shape returned by <c>GET /api/plugins</c>. One row per plugin
/// discovered at boot, regardless of load outcome — successful loads have
/// <see cref="LoadError"/> null; failed loads have null
/// <see cref="Status"/> "failed" and a populated <see cref="LoadError"/>
/// so the frontend Plugins settings page can show the operator why a
/// plugin didn't come up.
/// </summary>
public sealed record PluginInfo(
    string Id,
    string Name,
    string Version,
    string Author,
    string Description,
    Uri? HomepageUrl,
    IReadOnlyList<string> Capabilities,
    string Status,
    string? LoadError,
    DateTimeOffset LoadedAt);
