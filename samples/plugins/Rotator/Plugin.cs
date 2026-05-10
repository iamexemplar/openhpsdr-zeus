// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
//
// First non-trivial Zeus plugin: hamlib rotctld client. Replaces the
// in-tree RotctldService that previously lived in Zeus.Server.Hosting.
// The wire surface (5 endpoints under /api/rotator/*) and the contract
// DTOs (Zeus.Contracts.RotctldDtos) are unchanged so the existing
// frontend keeps working with no edits.

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;
using Zeus.Contracts;
using Zeus.Contracts.Plugins;
using Zeus.Plugins.Hosting;

namespace OpenHpsdr.Zeus.Plugins.Rotator;

public sealed class Plugin : IZeusPlugin, IPluginHttpEndpoints, IAsyncDisposable
{
    private RotctldClient? _client;
    private ILogger? _log;

    public PluginMetadata Metadata { get; } = new(
        Id: "com.openhpsdr.zeus.rotator",
        Name: "Rotator (rotctld)",
        Version: "1.0.0",
        Author: "OpenHPSDR Zeus contributors",
        Description: "Hamlib rotctld TCP client — exposes /api/rotator/{status,config,set,stop,test} so the frontend can drive an antenna rotator.",
        HomepageUrl: null,
        Capabilities: PluginCapabilities.NetworkAccess);

    public Task InitializeAsync(IPluginContext context, CancellationToken ct)
    {
        if (!context.Capabilities.HasFlag(PluginCapabilities.NetworkAccess))
        {
            throw new InvalidOperationException(
                "Rotator plugin requires NetworkAccess capability — declare it in plugin.json");
        }
        _log = context.Logger;
        _client = new RotctldClient(_log);
        return _client.StartAsync(ct);
    }

    public Task ShutdownAsync(CancellationToken ct)
        => _client?.StopAsync(ct) ?? Task.CompletedTask;

    public void MapEndpoints(IEndpointRouteBuilder endpoints)
    {
        if (_client is null)
            throw new InvalidOperationException("Rotator plugin MapEndpoints called before InitializeAsync");
        var rot = _client;

        endpoints.MapGet("/api/rotator/status", () => rot.GetStatus());

        endpoints.MapPost("/api/rotator/config", async (RotctldConfig req, HttpContext ctx) =>
        {
            _log?.LogInformation("api.rotator.config enabled={En} host={Host} port={Port}", req.Enabled, req.Host, req.Port);
            var status = await rot.SetConfigAsync(req, ctx.RequestAborted);
            return Results.Ok(status);
        });

        endpoints.MapPost("/api/rotator/set", async (RotctldSetAzRequest req, HttpContext ctx) =>
        {
            if (!double.IsFinite(req.Azimuth)) return Results.BadRequest(new { error = "azimuth must be finite" });
            var status = await rot.SetAzAsync(req.Azimuth, ctx.RequestAborted);
            if (!status.Connected) return Results.Json(status, statusCode: StatusCodes.Status503ServiceUnavailable);
            return Results.Ok(status);
        });

        endpoints.MapPost("/api/rotator/stop", async (HttpContext ctx) =>
        {
            var status = await rot.StopRotatorAsync(ctx.RequestAborted);
            return Results.Ok(status);
        });

        endpoints.MapPost("/api/rotator/test", async (RotctldTestRequest req, HttpContext ctx) =>
        {
            if (string.IsNullOrWhiteSpace(req.Host) || req.Port is <= 0 or >= 65536)
                return Results.BadRequest(new { error = "host and port required" });
            var result = await rot.TestAsync(req.Host.Trim(), req.Port, ctx.RequestAborted);
            return Results.Ok(result);
        });
    }

    public ValueTask DisposeAsync() => _client?.DisposeAsync() ?? ValueTask.CompletedTask;
}
