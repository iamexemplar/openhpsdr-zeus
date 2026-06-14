// SPDX-License-Identifier: GPL-2.0-or-later
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Zeus.Plugins.Host;

/// <summary>
/// Scans an operator-chosen directory for VST3 plugins and registers
/// each one as an installed Zeus plugin so it appears in the Audio Suite
/// chain. Each discovered <c>.vst3</c> becomes a generated plugin
/// package under the plugin root:
///
/// <code>
///   &lt;plugin-root&gt;/&lt;id&gt;/
///     ├── plugin.json                 (synthesized manifest)
///     ├── Zeus.Plugins.VstHostStub.dll (no-op managed entrypoint)
///     └── vst3/&lt;name&gt;.vst3         (copy of the discovered VST)
/// </code>
///
/// The stub assembly satisfies the loader's "every package ships an
/// IZeusPlugin assembly" rule WITHOUT touching the core loader; the
/// audio comes entirely from <c>audio.vst3Path</c>, which
/// AudioPluginBridge wraps in a VstHostAudioPlugin. After writing the
/// package the service calls <see cref="PluginManager.ActivateAsync"/>,
/// which attaches it to the chain exactly like a normally-installed
/// plugin.
///
/// <para>v1 scope: the generated manifest has no <c>ui</c> module, so the
/// frontend renders a synthetic generic panel for it. Real VST names and
/// parameter/editor surfaces need native-bridge introspection (a future
/// ABI bump); for now the display name is derived from the filename.</para>
/// </summary>
public sealed class VstDirectoryScanService
{
    private const string StubResourceName = "Zeus.Plugins.VstHostStub.dll";
    private const string StubAssemblyFile = "Zeus.Plugins.VstHostStub.dll";
    private const string IdPrefix = "com.openhpsdr.zeus.vst.";
    private const int MaxScanDepth = 5;

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    private readonly PluginManager _manager;
    private readonly string _pluginRoot;
    private readonly ILogger<VstDirectoryScanService> _log;

    public VstDirectoryScanService(
        PluginManager manager,
        string pluginRoot,
        ILogger<VstDirectoryScanService> log)
    {
        _manager = manager;
        _pluginRoot = pluginRoot;
        _log = log;
    }

    public sealed record ScannedVst(string Id, string Name, string Vst3Source);
    public sealed record ScanError(string Vst3Source, string Message);
    public sealed record ScanResult(
        string Directory,
        IReadOnlyList<ScannedVst> Registered,
        IReadOnlyList<ScannedVst> Skipped,
        IReadOnlyList<ScanError> Errors);

    /// <summary>
    /// Scan <paramref name="directory"/> for VST3 plugins and register
    /// each. Already-registered VSTs (same generated id) are skipped, not
    /// re-installed. Throws <see cref="DirectoryNotFoundException"/> if
    /// the directory doesn't exist.
    /// </summary>
    public async Task<ScanResult> ScanAsync(string directory, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(directory))
            throw new ArgumentException("directory is required", nameof(directory));
        if (!Directory.Exists(directory))
            throw new DirectoryNotFoundException($"directory not found: {directory}");

        var root = _pluginRoot;
        Directory.CreateDirectory(root);
        var entries = FindVst3Entries(directory);

        var registered = new List<ScannedVst>();
        var skipped = new List<ScannedVst>();
        var errors = new List<ScanError>();
        var usedIds = new HashSet<string>(StringComparer.Ordinal);
        var activeIds = new HashSet<string>(
            _manager.Active.Select(p => p.Loaded.Manifest.Id), StringComparer.Ordinal);

        foreach (var entry in entries)
        {
            ct.ThrowIfCancellationRequested();
            var name = Path.GetFileNameWithoutExtension(entry.TrimEnd(
                Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            var id = UniqueId(name, usedIds);
            usedIds.Add(id);

            try
            {
                if (activeIds.Contains(id))
                {
                    skipped.Add(new ScannedVst(id, name, entry));
                    continue;
                }

                var pluginDir = Path.Combine(root, id);
                Directory.CreateDirectory(pluginDir);

                // Copy the VST (file or bundle directory) under vst3/.
                var vst3Rel = $"vst3/{name}.vst3";
                var vst3Dest = Path.Combine(pluginDir, "vst3", $"{name}.vst3");
                Directory.CreateDirectory(Path.GetDirectoryName(vst3Dest)!);
                CopyVst3(entry, vst3Dest);

                WriteStubAssembly(Path.Combine(pluginDir, StubAssemblyFile));
                await File.WriteAllTextAsync(
                    Path.Combine(pluginDir, "plugin.json"),
                    BuildManifestJson(id, name, vst3Rel), ct).ConfigureAwait(false);

                await _manager.ActivateAsync(pluginDir, ct).ConfigureAwait(false);
                registered.Add(new ScannedVst(id, name, entry));
                _log.LogInformation("Registered scanned VST '{Name}' as {Id}", name, id);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Failed to register scanned VST {Entry}", entry);
                errors.Add(new ScanError(entry, ex.Message));
            }
        }

        return new ScanResult(directory, registered, skipped, errors);
    }

    /// <summary>
    /// Walk <paramref name="root"/> for <c>*.vst3</c> entries (file OR
    /// bundle directory), bounded in depth and NOT descending into a
    /// found bundle.
    /// </summary>
    private static List<string> FindVst3Entries(string root)
    {
        var found = new List<string>();
        void Walk(string dir, int depth)
        {
            if (depth > MaxScanDepth) return;
            IEnumerable<string> entries;
            try { entries = Directory.EnumerateFileSystemEntries(dir); }
            catch { return; } // unreadable dir — skip
            foreach (var e in entries)
            {
                if (e.EndsWith(".vst3", StringComparison.OrdinalIgnoreCase))
                {
                    found.Add(e); // file or bundle — record, don't descend in
                    continue;
                }
                if (Directory.Exists(e)) Walk(e, depth + 1);
            }
        }
        Walk(root, 0);
        return found;
    }

    private static void CopyVst3(string source, string dest)
    {
        if (Directory.Exists(source))
            CopyDirectory(source, dest);
        else
            File.Copy(source, dest, overwrite: true);
    }

    private static void CopyDirectory(string source, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.EnumerateFiles(source))
            File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: true);
        foreach (var sub in Directory.EnumerateDirectories(source))
            CopyDirectory(sub, Path.Combine(dest, Path.GetFileName(sub)));
    }

    private static void WriteStubAssembly(string destPath)
    {
        using var res = typeof(VstDirectoryScanService).Assembly
            .GetManifestResourceStream(StubResourceName)
            ?? throw new InvalidOperationException(
                $"embedded stub resource '{StubResourceName}' not found");
        using var file = File.Create(destPath);
        res.CopyTo(file);
    }

    private static string BuildManifestJson(string id, string name, string vst3Rel)
    {
        // Anonymous object keyed to the manifest's JsonPropertyName values
        // (camelCase). slot "tx.post-leveler" routes the VST into the TX
        // insert chain so it lands in the Audio Suite rack.
        var manifest = new
        {
            schemaVersion = 1,
            id,
            name,
            version = "1.0.0",
            author = "Scanned VST",
            description = $"VST3 plugin registered from a scanned directory ({name}).",
            license = "Unknown",
            sdk = new { abi = 1, minVersion = "1.0.0" },
            entrypoint = new { assembly = StubAssemblyFile },
            audio = new
            {
                vst3Path = vst3Rel,
                slot = "tx.post-leveler",
                channels = 1,
                sampleRate = 48000,
            },
        };
        return JsonSerializer.Serialize(manifest, JsonOpts);
    }

    private static string UniqueId(string name, HashSet<string> used)
    {
        var slug = Slugify(name);
        if (slug.Length == 0) slug = "plugin";
        var id = IdPrefix + slug;
        if (!used.Contains(id)) return id;
        for (int i = 2; ; i++)
        {
            var candidate = $"{IdPrefix}{slug}{i}";
            if (!used.Contains(candidate)) return candidate;
        }
    }

    /// <summary>
    /// Reduce a display name to the id charset: lowercase [a-z0-9] only
    /// (the manifest id pattern allows dots but not hyphens; we drop
    /// everything that isn't a letter or digit). Must end on alnum.
    /// </summary>
    private static string Slugify(string name)
    {
        var sb = new StringBuilder(name.Length);
        foreach (var ch in name.ToLowerInvariant())
        {
            if (ch is >= 'a' and <= 'z' or >= '0' and <= '9') sb.Append(ch);
        }
        return sb.ToString();
    }
}
