// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
//
// See ATTRIBUTIONS.md at the repository root for the full provenance
// statement and per-component attribution.

using Microsoft.AspNetCore.Routing;

namespace Zeus.Plugins.Hosting;

/// <summary>
/// Optional extension point a plugin implements alongside
/// <c>IZeusPlugin</c> when it wants to contribute HTTP endpoints to the
/// Zeus host. The host invokes <see cref="MapEndpoints"/> once during
/// startup, after the plugin's <c>InitializeAsync</c> has completed and
/// before the request pipeline accepts traffic.
///
/// Routing collisions with core Zeus endpoints (or other plugins) surface
/// as ASP.NET startup errors — plugins are expected to namespace under a
/// path that won't collide (typically <c>/api/&lt;plugin-id&gt;/...</c>);
/// the rotator plugin is the deliberate exception, where the URLs predate
/// the plugin extraction and are kept stable for the existing frontend.
/// </summary>
public interface IPluginHttpEndpoints
{
    /// <summary>
    /// Map this plugin's HTTP endpoints onto <paramref name="endpoints"/>.
    /// Called exactly once per plugin lifetime, on the main thread,
    /// before the host starts servicing requests.
    /// </summary>
    void MapEndpoints(IEndpointRouteBuilder endpoints);
}
