// SPDX-License-Identifier: GPL-2.0-or-later
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Zeus.Plugins.Host;

namespace Zeus.Plugins.Host.Tests;

/// <summary>
/// Tests for <see cref="VstDirectoryScanService"/> — scanning a folder
/// of .vst3 files and registering each as a generated plugin package
/// (stub assembly + synthesized manifest) that activates into the
/// plugin manager. Uses fake .vst3 files: activation loads only the
/// embedded managed stub, never the (absent) native VST, so these run
/// without the native bridge.
/// </summary>
public class VstDirectoryScanServiceTests : IDisposable
{
    private readonly string _root;
    private readonly string _srcDir;
    private readonly PluginSettingsStore _store;
    private readonly PluginManager _manager;
    private readonly VstDirectoryScanService _scanner;

    public VstDirectoryScanServiceTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "zeus-vstscan-" + Guid.NewGuid().ToString("N"));
        _srcDir = Path.Combine(_root, "src");
        Directory.CreateDirectory(_srcDir);

        _store = new PluginSettingsStore(Path.Combine(_root, "settings.db"));
        _manager = new PluginManager(
            loader: new PluginLoader(NullLogger<PluginLoader>.Instance),
            settings: _store,
            services: new ServiceCollection().BuildServiceProvider(),
            logFactory: NullLoggerFactory.Instance,
            options: new PluginManagerOptions { PluginRoot = Path.Combine(_root, "plugins") });

        _scanner = new VstDirectoryScanService(
            _manager,
            Path.Combine(_root, "plugins"),
            NullLogger<VstDirectoryScanService>.Instance);
    }

    public void Dispose()
    {
        _manager.DisposeAsync().AsTask().GetAwaiter().GetResult();
        _store.Dispose();
        try { Directory.Delete(_root, recursive: true); } catch { /* ignore */ }
    }

    private void WriteFakeVst(string fileName) =>
        File.WriteAllBytes(Path.Combine(_srcDir, fileName), new byte[] { 1, 2, 3, 4 });

    [Fact]
    public async Task Scan_Registers_Vst_And_Activates_It()
    {
        WriteFakeVst("TDR Nova.vst3");

        var result = await _scanner.ScanAsync(_srcDir, default);

        Assert.Single(result.Registered);
        var reg = result.Registered[0];
        Assert.Equal("TDR Nova", reg.Name);
        Assert.Equal("com.openhpsdr.zeus.vst.tdrnova", reg.Id);
        Assert.Empty(result.Errors);

        // Activated into the manager.
        Assert.Contains(_manager.Active, p => p.Loaded.Manifest.Id == reg.Id);

        // Package on disk: manifest + stub assembly + copied VST.
        var dir = Path.Combine(_root, "plugins", reg.Id);
        Assert.True(File.Exists(Path.Combine(dir, "plugin.json")));
        Assert.True(File.Exists(Path.Combine(dir, "Zeus.Plugins.VstHostStub.dll")));
        Assert.True(File.Exists(Path.Combine(dir, "vst3", "TDR Nova.vst3")));

        // Manifest declares the relative vst3Path + tx slot.
        var manifest = await File.ReadAllTextAsync(Path.Combine(dir, "plugin.json"));
        Assert.Contains("vst3/TDR Nova.vst3", manifest);
        Assert.Contains("tx.post-leveler", manifest);
    }

    [Fact]
    public async Task Scan_Skips_Already_Registered_On_Second_Pass()
    {
        WriteFakeVst("Comp.vst3");

        var first = await _scanner.ScanAsync(_srcDir, default);
        Assert.Single(first.Registered);

        var second = await _scanner.ScanAsync(_srcDir, default);
        Assert.Empty(second.Registered);
        Assert.Single(second.Skipped);
        Assert.Equal("com.openhpsdr.zeus.vst.comp", second.Skipped[0].Id);
    }

    [Fact]
    public async Task Scan_Registers_Multiple_With_Distinct_Ids()
    {
        WriteFakeVst("Reverb.vst3");
        WriteFakeVst("Limiter.vst3");

        var result = await _scanner.ScanAsync(_srcDir, default);

        Assert.Equal(2, result.Registered.Count);
        Assert.Equal(2, result.Registered.Select(r => r.Id).Distinct().Count());
    }

    [Fact]
    public async Task Scan_Missing_Directory_Throws()
    {
        await Assert.ThrowsAsync<DirectoryNotFoundException>(
            () => _scanner.ScanAsync(Path.Combine(_root, "does-not-exist"), default));
    }
}
