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

using Zeus.Contracts.Plugins;

namespace Zeus.Server.Plugins;

/// <summary>
/// Default in-process implementation of <see cref="IPluginContext"/>.
/// PR-B wires PluginId, a scoped logger, and the resolved capability
/// grants from the manifest. Later phases will add Radio / Settings /
/// Network / FileSystem subsystems and per-capability accessors.
/// </summary>
internal sealed class PluginContext : IPluginContext
{
    public string PluginId { get; }
    public ILogger Logger { get; }
    public PluginCapabilities Capabilities { get; }

    public PluginContext(string pluginId, ILogger logger, PluginCapabilities capabilities)
    {
        PluginId = pluginId;
        Logger = logger;
        Capabilities = capabilities;
    }
}
