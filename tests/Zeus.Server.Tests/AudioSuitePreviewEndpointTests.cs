// SPDX-License-Identifier: GPL-2.0-or-later

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Zeus.Server;

namespace Zeus.Server.Tests;

public class AudioSuitePreviewEndpointTests : IClassFixture<AudioSuitePreviewEndpointTests.Factory>
{
    private readonly Factory _factory;
    public AudioSuitePreviewEndpointTests(Factory factory) => _factory = factory;

    [Fact]
    public async Task GetReportsTxMonitorState()
    {
        using var client = _factory.CreateClient();

        using var json = await client.GetFromJsonAsync<JsonDocument>("/api/audio-suite/preview");

        Assert.NotNull(json);
        Assert.True(json!.RootElement.GetProperty("supported").GetBoolean());
        Assert.False(json.RootElement.GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task PutTogglesTxMonitorState()
    {
        using var scope = _factory.Services.CreateScope();
        var radio = scope.ServiceProvider.GetRequiredService<RadioService>();
        using var client = _factory.CreateClient();

        var on = await client.PutAsJsonAsync("/api/audio-suite/preview", new { enabled = true });
        Assert.Equal(HttpStatusCode.OK, on.StatusCode);
        Assert.True(radio.Snapshot().TxMonitorEnabled);

        var off = await client.PutAsJsonAsync("/api/audio-suite/preview", new { enabled = false });
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        Assert.False(radio.Snapshot().TxMonitorEnabled);
    }

    [Fact]
    public async Task TxPreviewAliasTogglesSameTxMonitorState()
    {
        using var scope = _factory.Services.CreateScope();
        var radio = scope.ServiceProvider.GetRequiredService<RadioService>();
        using var client = _factory.CreateClient();

        var on = await client.PutAsJsonAsync("/api/tx-audio-suite/preview", new { enabled = true });
        Assert.Equal(HttpStatusCode.OK, on.StatusCode);
        Assert.True(radio.Snapshot().TxMonitorEnabled);

        using var json = await client.GetFromJsonAsync<JsonDocument>("/api/tx-audio-suite/preview");
        Assert.NotNull(json);
        Assert.True(json!.RootElement.GetProperty("supported").GetBoolean());
        Assert.True(json.RootElement.GetProperty("enabled").GetBoolean());

        var off = await client.PutAsJsonAsync("/api/tx-audio-suite/preview", new { enabled = false });
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        Assert.False(radio.Snapshot().TxMonitorEnabled);
    }

    [Fact]
    public async Task TxSuiteAliasesExposeTxRouteSurfaces()
    {
        using var client = _factory.CreateClient();

        var mode = await client.GetAsync("/api/tx-audio-suite/processing-mode");
        var order = await client.GetAsync("/api/tx-audio-suite/chain/order");
        var meters = await client.GetAsync("/api/tx-audio-suite/chain/meters");
        var rxMeters = await client.GetAsync("/api/rx-audio-suite/chain/meters");
        var txScan = await client.PostAsJsonAsync("/api/tx-audio-suite/scan-vst-directory", new { directory = "" });
        var rxScan = await client.PostAsJsonAsync("/api/rx-audio-suite/scan-vst-directory", new { directory = "" });

        Assert.Equal(HttpStatusCode.OK, mode.StatusCode);
        Assert.Equal(HttpStatusCode.OK, order.StatusCode);
        Assert.Equal(HttpStatusCode.OK, meters.StatusCode);
        Assert.Equal(HttpStatusCode.OK, rxMeters.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, txScan.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, rxScan.StatusCode);
    }

    public sealed class Factory : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Test");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IHostedService>();
            });
        }
    }
}
