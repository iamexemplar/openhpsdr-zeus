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

using Microsoft.Extensions.Logging;

namespace Zeus.Contracts.Plugins;

/// <summary>
/// Sandbox boundary handed to a plugin during <see cref="IZeusPlugin.InitializeAsync"/>.
/// The plugin must keep this reference for its lifetime; the host uses the
/// presence/absence of subsystems on this interface to enforce the
/// capability flags declared in the manifest.
///
/// PR-B: PluginId, Logger, and Capabilities are wired. The granted flags
/// reflect the manifest's <c>capabilities</c> array — plugins should check
/// before doing privileged work (network sockets, file IO, child
/// processes). Strongly-typed subsystem accessors (network, filesystem,
/// radio control) and per-plugin settings storage land in later phases.
/// </summary>
public interface IPluginContext
{
    /// <summary>Reverse-DNS plugin id, identical to the manifest Id.</summary>
    string PluginId { get; }

    /// <summary>
    /// Logger scoped to this plugin (category prefix is the plugin id) so
    /// log lines from a plugin are easy to filter and route to the
    /// per-plugin diagnostics page in the future.
    /// </summary>
    ILogger Logger { get; }

    /// <summary>
    /// Capabilities the host has granted to this plugin. The host has
    /// already verified that the assembly's declared
    /// <see cref="PluginMetadata.Capabilities"/> is a subset of the
    /// manifest grants — a plugin reading this value sees what was
    /// actually approved, not what it asked for.
    /// </summary>
    PluginCapabilities Capabilities { get; }
}
