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

using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Text.Json;
using Zeus.Contracts.Plugins;
using Zeus.Plugins.Hosting;

namespace Zeus.Server.Plugins;

/// <summary>
/// PR-A foundation: discovers plugins under the per-platform XDG plugin
/// directory, loads each via a collectible <see cref="AssemblyLoadContext"/>,
/// instantiates the unique <see cref="IZeusPlugin"/> implementation, and
/// drives its lifecycle. Capability enforcement, settings storage, and
/// the REST/UI surfaces land in PR-B and PR-C.
///
/// Failure isolation: every plugin operation is wrapped so one bad plugin
/// can never block host boot or shutdown — failures are recorded on the
/// per-plugin <see cref="LoadedPlugin"/> and surfaced via diagnostics.
/// </summary>
public sealed class PluginManager : IHostedService
{
    private static readonly TimeSpan InitTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(5);

    private static readonly JsonSerializerOptions ManifestJsonOptions = new(JsonSerializerDefaults.Web)
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private readonly ILogger<PluginManager> _log;
    private readonly ILoggerFactory _loggerFactory;
    private readonly IConfiguration _config;
    private readonly List<LoadedPlugin> _plugins = new();
    private readonly object _gate = new();
    private bool _loaded;

    public PluginManager(ILogger<PluginManager> log, ILoggerFactory loggerFactory, IConfiguration config)
    {
        _log = log;
        _loggerFactory = loggerFactory;
        _config = config;
    }

    /// <summary>
    /// Snapshot of the loaded-plugin list, both successful and failed.
    /// PR-B will project this through the /api/plugins endpoint.
    /// </summary>
    public IReadOnlyList<LoadedPlugin> Plugins
    {
        get { lock (_gate) return _plugins.ToArray(); }
    }

    /// <summary>
    /// Per-user XDG plugin directory for the current platform.
    /// Linux:   <c>~/.local/share/zeus/plugins/</c>
    /// macOS:   <c>~/Library/Application Support/Zeus/plugins/</c>
    /// Windows: <c>%APPDATA%\Zeus\plugins\</c>
    /// </summary>
    public static string ResolveUserPluginDirectory()
    {
        // On Linux and macOS, LocalApplicationData maps to the per-user
        // data root (~/.local/share and ~/Library/Application Support
        // respectively). On Windows, ApplicationData is the Roaming
        // %APPDATA% folder, which is the conventional install location
        // for per-user app data that should follow a user across machines.
        var (root, vendor) = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? (Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Zeus")
            : RuntimeInformation.IsOSPlatform(OSPlatform.OSX)
                ? (Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Zeus")
                : (Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "zeus");
        return Path.Combine(root, vendor, "plugins");
    }

    /// <summary>
    /// Plugin directory next to the Zeus binary — populated by build /
    /// publish for plugins that ship with Zeus (e.g. the in-tree rotator
    /// sample). Operators don't normally write here.
    /// </summary>
    public static string ResolveAppPluginDirectory()
        => Path.Combine(AppContext.BaseDirectory, "plugins");

    private string[] ResolvePluginDirectories()
    {
        // Config override (single directory) wins — this keeps tests
        // hermetic and lets operators with non-standard installs point
        // at /opt/zeus/plugins/ etc.
        var configured = _config.GetValue<string?>("Plugins:Directory");
        if (!string.IsNullOrWhiteSpace(configured)) return new[] { configured };

        // Default: scan both the app-shipped dir and the per-user XDG
        // dir. Either may be missing and that's fine.
        return new[] { ResolveAppPluginDirectory(), ResolveUserPluginDirectory() };
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Idempotent: ZeusHost.Build() typically calls LoadAsync directly so
        // that plugin HTTP endpoints can be mapped before the request
        // pipeline accepts traffic. If that pre-load already happened this
        // is a no-op; otherwise (e.g. unit tests that just spin up the
        // hosted-service surface) we run discovery here.
        if (_loaded) return Task.CompletedTask;
        return LoadAsync(cancellationToken);
    }

    /// <summary>
    /// Discover, load, and initialise every plugin under the resolved
    /// plugin directory. Idempotent — calling more than once is a no-op.
    /// Intended to be invoked from <c>ZeusHost.Build()</c> after the
    /// service container is ready but before route mapping, so plugins
    /// that implement <c>IPluginHttpEndpoints</c> can register routes
    /// alongside core Zeus endpoints.
    /// </summary>
    public async Task LoadAsync(CancellationToken cancellationToken)
    {
        if (_loaded) return;
        _loaded = true;

        if (IsSafeMode())
        {
            _log.LogInformation("plugins disabled (safe mode); skipping discovery");
            return;
        }

        var dirs = ResolvePluginDirectories();
        var manifests = new List<string>();
        foreach (var dir in dirs)
        {
            try
            {
                if (!Directory.Exists(dir)) continue;
                manifests.AddRange(Directory.EnumerateFiles(dir, "plugin.json", SearchOption.AllDirectories));
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "plugin discovery failed under {Dir}; skipping", dir);
            }
        }

        if (manifests.Count == 0)
        {
            _log.LogInformation("no plugins found under {Dirs}", string.Join(", ", dirs));
            return;
        }

        _log.LogInformation("discovered {Count} plugin manifest(s) across {Dirs}",
            manifests.Count, string.Join(", ", dirs));
        // Each plugin is allowed up to InitTimeout; a hung plugin will not
        // stall boot beyond that.
        foreach (var manifestPath in manifests)
        {
            await LoadOne(manifestPath, cancellationToken);
        }
    }

    /// <summary>
    /// Map every loaded plugin's HTTP endpoints onto <paramref name="endpoints"/>.
    /// Plugins that don't implement <see cref="IPluginHttpEndpoints"/> are
    /// skipped silently. Failures inside a plugin's MapEndpoints call are
    /// caught and recorded as a load error against the plugin so they
    /// surface in /api/plugins diagnostics; a misbehaving plugin can never
    /// stall the host's route registration.
    /// </summary>
    public void MapEndpoints(IEndpointRouteBuilder endpoints)
    {
        LoadedPlugin[] snapshot;
        lock (_gate) snapshot = _plugins.ToArray();

        foreach (var p in snapshot)
        {
            if (p.Instance is not IPluginHttpEndpoints httpPlugin) continue;
            try
            {
                httpPlugin.MapEndpoints(endpoints);
                _log.LogInformation("mapped HTTP endpoints for plugin {Id}", p.Manifest.Id);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "plugin {Id} MapEndpoints failed", p.Manifest.Id);
                // Replace the LoadedPlugin entry with one carrying the
                // route-registration error so /api/plugins shows it.
                lock (_gate)
                {
                    var idx = _plugins.IndexOf(p);
                    if (idx >= 0)
                    {
                        _plugins[idx] = p with { LoadError = $"MapEndpoints failed: {ex.Message}" };
                    }
                }
            }
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        LoadedPlugin[] snapshot;
        lock (_gate) snapshot = _plugins.ToArray();

        foreach (var p in snapshot)
        {
            if (p.Instance is null) continue;
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(ShutdownTimeout);
                await p.Instance.ShutdownAsync(cts.Token);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "plugin {Id} shutdown failed", p.Manifest.Id);
            }
            finally
            {
                try { p.LoadContext?.Unload(); }
                catch (Exception ex) { _log.LogWarning(ex, "plugin {Id} ALC unload failed", p.Manifest.Id); }
            }
        }
    }

    private async Task LoadOne(string manifestPath, CancellationToken ct)
    {
        var pluginDir = Path.GetDirectoryName(manifestPath)!;
        PluginManifest? manifest = null;
        try
        {
            var json = await File.ReadAllTextAsync(manifestPath, ct);
            manifest = JsonSerializer.Deserialize<PluginManifest>(json, ManifestJsonOptions);
            if (manifest is null) throw new InvalidDataException("manifest deserialised to null");
            ValidateManifest(manifest, pluginDir);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "failed to read manifest at {Path}", manifestPath);
            // Record without an Instance/ALC so diagnostics can show the failure.
            // Use a placeholder manifest if we couldn't parse one.
            var placeholder = manifest ?? new PluginManifest(
                Id: $"<unparsable:{Path.GetFileName(pluginDir)}>",
                Name: Path.GetFileName(pluginDir),
                Version: "0.0.0",
                Author: "",
                Description: "",
                HomepageUrl: null,
                Assembly: "",
                Capabilities: Array.Empty<string>(),
                ResourceLimits: null);
            Record(new LoadedPlugin(placeholder, null, null, ex.Message, DateTimeOffset.UtcNow));
            return;
        }

        var asmPath = Path.Combine(pluginDir, manifest.Assembly);
        AssemblyLoadContext? alc = null;
        try
        {
            alc = new AssemblyLoadContext(name: manifest.Id, isCollectible: true);
            var asm = alc.LoadFromAssemblyPath(asmPath);
            var pluginType = FindPluginType(asm);
            var instance = (IZeusPlugin)Activator.CreateInstance(pluginType)!;

            // Cross-check: assembly Metadata.Id must equal manifest Id.
            // Mismatches usually mean a copy-paste error and could be a
            // capability-elevation attempt (manifest declares minimal
            // caps, assembly assumes more) — refuse to load.
            if (!string.Equals(instance.Metadata.Id, manifest.Id, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"manifest Id '{manifest.Id}' does not match assembly Metadata.Id '{instance.Metadata.Id}'");
            }

            // Parse the manifest's capability strings into the flags enum
            // and verify the assembly's declared metadata fits inside the
            // manifest grant. The manifest is the trust boundary — an
            // assembly that requests more than the manifest declares is
            // refused so a malicious plugin can't quietly elevate by
            // shipping an assembly with bigger Metadata.Capabilities than
            // the manifest the user approved.
            var grantedCaps = ParseCapabilities(manifest.Capabilities);
            var requestedCaps = instance.Metadata.Capabilities;
            if ((requestedCaps & ~grantedCaps) != PluginCapabilities.None)
            {
                throw new InvalidOperationException(
                    $"assembly requests capabilities {requestedCaps} but manifest only grants {grantedCaps}; refusing to load");
            }

            var pluginLogger = _loggerFactory.CreateLogger($"Plugin.{manifest.Id}");
            var ctx = new PluginContext(manifest.Id, pluginLogger, grantedCaps);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(InitTimeout);
            await instance.InitializeAsync(ctx, cts.Token);

            Record(new LoadedPlugin(manifest, instance, alc, null, DateTimeOffset.UtcNow));
            _log.LogInformation("loaded plugin {Id} v{Version}", manifest.Id, manifest.Version);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "failed to load plugin {Id} from {Path}", manifest.Id, asmPath);
            try { alc?.Unload(); } catch { /* ignore */ }
            Record(new LoadedPlugin(manifest, null, null, ex.Message, DateTimeOffset.UtcNow));
        }
    }

    private void Record(LoadedPlugin p)
    {
        lock (_gate) _plugins.Add(p);
    }

    private static PluginCapabilities ParseCapabilities(IReadOnlyList<string> names)
    {
        var caps = PluginCapabilities.None;
        foreach (var n in names)
        {
            if (string.IsNullOrWhiteSpace(n)) continue;
            if (!Enum.TryParse<PluginCapabilities>(n.Trim(), ignoreCase: true, out var flag))
                throw new InvalidDataException($"unknown capability '{n}' in manifest");
            if (flag == PluginCapabilities.None) continue;
            caps |= flag;
        }
        return caps;
    }

    private static Type FindPluginType(Assembly asm)
    {
        var candidates = asm.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && typeof(IZeusPlugin).IsAssignableFrom(t))
            .ToList();
        return candidates.Count switch
        {
            0 => throw new InvalidOperationException($"no IZeusPlugin implementation found in {asm.GetName().Name}"),
            > 1 => throw new InvalidOperationException(
                $"multiple IZeusPlugin implementations found in {asm.GetName().Name}: {string.Join(", ", candidates.Select(t => t.FullName))}"),
            _ => candidates[0],
        };
    }

    private static void ValidateManifest(PluginManifest m, string pluginDir)
    {
        if (string.IsNullOrWhiteSpace(m.Id)) throw new InvalidDataException("manifest Id is required");
        if (string.IsNullOrWhiteSpace(m.Version)) throw new InvalidDataException("manifest Version is required");
        if (string.IsNullOrWhiteSpace(m.Assembly)) throw new InvalidDataException("manifest Assembly is required");
        if (!string.Equals(m.Isolation, "inprocess", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"isolation '{m.Isolation}' is not supported in v1 (expected 'inprocess')");

        // Reject parent-relative paths so a malicious manifest can't load a
        // dll outside the plugin's own directory.
        if (m.Assembly.Contains("..", StringComparison.Ordinal) || Path.IsPathRooted(m.Assembly))
            throw new InvalidDataException($"manifest Assembly must be a simple filename: '{m.Assembly}'");

        var asmPath = Path.Combine(pluginDir, m.Assembly);
        if (!File.Exists(asmPath))
            throw new FileNotFoundException($"plugin assembly not found: {asmPath}");
    }

    private bool IsSafeMode()
    {
        // Two routes: the standard configuration system (env var
        // Plugins__Disabled, command-line --Plugins:Disabled, appsettings)
        // and a friendlier --no-plugins shorthand that operators are more
        // likely to remember and reach for in a panic.
        if (_config.GetValue("Plugins:Disabled", false)) return true;
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], "--no-plugins", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }
}
