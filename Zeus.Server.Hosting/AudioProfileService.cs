// SPDX-License-Identifier: GPL-2.0-or-later
namespace Zeus.Server;

/// <summary>
/// Orchestrates Audio Suite profiles: capturing the current chain
/// configuration into a named snapshot and applying a saved one back.
/// A profile spans two seams — <see cref="ChainOrderService"/> (active
/// order + parked set) and <see cref="AudioChainMasterBypassService"/>
/// (master lever) — so this service is the single place that reads /
/// writes both atomically on the operator's behalf.
/// </summary>
public sealed class AudioProfileService
{
    private readonly AudioProfileStore _store;
    private readonly ChainOrderService _chainOrder;
    private readonly AudioChainMasterBypassService _masterBypass;
    private readonly ILogger<AudioProfileService> _log;

    public AudioProfileService(
        AudioProfileStore store,
        ChainOrderService chainOrder,
        AudioChainMasterBypassService masterBypass,
        ILogger<AudioProfileService> log)
    {
        _store = store;
        _chainOrder = chainOrder;
        _masterBypass = masterBypass;
        _log = log;
    }

    public IReadOnlyList<AudioProfileEntry> List() => _store.List();

    /// <summary>
    /// Snapshot the live chain config under <paramref name="name"/>
    /// (overwriting an existing profile of the same name).
    /// </summary>
    public AudioProfileEntry SaveCurrent(string name)
    {
        var entry = _store.Save(
            name,
            _chainOrder.CurrentOrder,
            _chainOrder.ParkedIds,
            _masterBypass.IsBypassed);
        _log.LogInformation(
            "Audio profile '{Name}' saved ({Active} active, {Parked} parked, masterBypass={Bypass})",
            name, entry.Order.Count, entry.Parked.Count, entry.MasterBypass);
        return entry;
    }

    /// <summary>
    /// Apply a saved profile by name. Returns false if no such profile.
    /// Order matters: reconcile chain membership + order first, then the
    /// master lever, so the chain is in its final shape before it goes
    /// hot / inert.
    /// </summary>
    public bool Apply(string name)
    {
        var profile = _store.Get(name);
        if (profile is null) return false;

        _chainOrder.ApplyMembershipAndOrder(profile.Order, profile.Parked);
        _masterBypass.SetMasterBypassed(profile.MasterBypass);
        _log.LogInformation("Audio profile '{Name}' applied", name);
        return true;
    }

    public bool Delete(string name) => _store.Delete(name);
}
