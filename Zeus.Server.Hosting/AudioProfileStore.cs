// SPDX-License-Identifier: GPL-2.0-or-later
using LiteDB;

namespace Zeus.Server;

/// <summary>
/// Persists named Audio Suite "profiles" — operator snapshots of the
/// chain configuration: the active plugin order, the parked
/// (installed-but-out-of-chain) set, and the master-bypass lever. A
/// profile is a recallable voicing layout ("Contest", "Ragchew") that
/// reshapes the rack in one click.
///
/// <para>Mirrors the <see cref="ChainOrderStore"/> / FilterPresetStore
/// pattern: a typed POCO in a single LiteDB collection
/// ("audio_profiles") sharing <c>zeus-prefs.db</c>, lock-guarded
/// upsert, no schema migrations (LiteDB tolerates rows written by older
/// builds with missing fields).</para>
///
/// <para><b>Scope (v1):</b> a profile captures CHAIN-LEVEL config only
/// — which plugins are in the chain, their order, what's parked, and
/// master bypass. It does NOT capture per-plugin knob positions (EQ
/// curve, comp ratio): those live in <c>PluginSettingsStore</c> and a
/// running plugin only reads them at init, so there's no live-reload
/// path to apply them yet. Documented as a follow-up.</para>
/// </summary>
public sealed class AudioProfileStore : IDisposable
{
    private readonly LiteDatabase _db;
    private readonly ILiteCollection<AudioProfileEntry> _profiles;
    private readonly ILogger<AudioProfileStore> _log;
    private readonly object _sync = new();

    public AudioProfileStore(ILogger<AudioProfileStore> log, string? dbPathOverride = null)
    {
        _log = log;
        var dbPath = dbPathOverride ?? PrefsDbPath.Get();
        var dir = Path.GetDirectoryName(dbPath);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        _db = new LiteDatabase($"Filename={dbPath};Connection=shared");
        _profiles = _db.GetCollection<AudioProfileEntry>("audio_profiles");
        _profiles.EnsureIndex(x => x.Name, unique: true);

        _log.LogInformation("AudioProfileStore initialized at {Path}", dbPath);
    }

    /// <summary>All saved profiles, newest-updated first.</summary>
    public IReadOnlyList<AudioProfileEntry> List()
    {
        lock (_sync)
            return _profiles.FindAll()
                .OrderByDescending(p => p.UpdatedUtc)
                .ToList();
    }

    public AudioProfileEntry? Get(string name)
    {
        lock (_sync)
            return _profiles.FindOne(p => p.Name == name);
    }

    /// <summary>
    /// Upsert a profile by name. Re-saving an existing name overwrites
    /// it (keeps CreatedUtc, bumps UpdatedUtc).
    /// </summary>
    public AudioProfileEntry Save(
        string name,
        IReadOnlyList<string> order,
        IReadOnlyList<string> parked,
        bool masterBypass)
    {
        lock (_sync)
        {
            var nowUtc = DateTime.UtcNow;
            var existing = _profiles.FindOne(p => p.Name == name);
            if (existing is null)
            {
                var entry = new AudioProfileEntry
                {
                    Name = name,
                    Order = order.ToList(),
                    Parked = parked.ToList(),
                    MasterBypass = masterBypass,
                    CreatedUtc = nowUtc,
                    UpdatedUtc = nowUtc,
                };
                _profiles.Insert(entry);
                return entry;
            }
            existing.Order = order.ToList();
            existing.Parked = parked.ToList();
            existing.MasterBypass = masterBypass;
            existing.UpdatedUtc = nowUtc;
            _profiles.Update(existing);
            return existing;
        }
    }

    /// <summary>Delete a profile by name. Returns true if one was removed.</summary>
    public bool Delete(string name)
    {
        lock (_sync)
            return _profiles.DeleteMany(p => p.Name == name) > 0;
    }

    public void Dispose() => _db.Dispose();
}

public sealed class AudioProfileEntry
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Order { get; set; } = new();
    public List<string> Parked { get; set; } = new();
    public bool MasterBypass { get; set; }
    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}
