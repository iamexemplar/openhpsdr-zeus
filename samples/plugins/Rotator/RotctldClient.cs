// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.
//
// Persistent TCP client for hamlib's rotctld. Holds a single socket,
// sends commands, polls position at RotctldConfig.PollingIntervalMs,
// and reconnects with 5-second backoff on failure.
//
// Lifted from the in-tree Zeus.Server.Hosting/RotctldService.cs verbatim
// — the only changes are: (1) base class is gone (the plugin owns the
// loop via StartAsync/StopAsync), (2) namespace moved into the plugin.

using System.Globalization;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Logging;
using Zeus.Contracts;

namespace OpenHpsdr.Zeus.Plugins.Rotator;

internal sealed class RotctldClient : IAsyncDisposable
{
    private const int MovingEpsilonDeg = 1;
    private static readonly TimeSpan ReconnectBackoff = TimeSpan.FromSeconds(5);

    private readonly ILogger _log;
    private readonly SemaphoreSlim _io = new(1, 1);

    private TcpClient? _client;
    private StreamReader? _reader;
    private StreamWriter? _writer;

    private volatile RotctldConfig _config = new();
    private volatile bool _connected;
    private volatile string? _lastError;

    private readonly object _state = new();
    private double? _currentAz;
    private double? _targetAz;
    private DateTime _lastCommandUtc;

    private readonly SemaphoreSlim _configChanged = new(0, 1);

    private CancellationTokenSource? _loopCts;
    private Task? _loopTask;

    public RotctldClient(ILogger log)
    {
        _log = log;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _loopCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _loopTask = Task.Run(() => RunLoop(_loopCts.Token));
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        try { _loopCts?.Cancel(); } catch { /* ignore */ }
        if (_loopTask is not null)
        {
            try { await _loopTask.WaitAsync(ct); } catch { /* ignore */ }
        }
        DisconnectLocked();
    }

    public RotctldStatus GetStatus()
    {
        double? cur, tgt;
        lock (_state) { cur = _currentAz; tgt = _targetAz; }
        var moving = tgt != null && cur != null && Math.Abs(NormDelta(tgt.Value - cur.Value)) > MovingEpsilonDeg;
        return new RotctldStatus(
            Enabled: _config.Enabled,
            Connected: _connected,
            Host: _config.Host,
            Port: _config.Port,
            CurrentAz: cur,
            TargetAz: tgt,
            Moving: moving,
            Error: _lastError);
    }

    public async Task<RotctldStatus> SetConfigAsync(RotctldConfig next, CancellationToken ct)
    {
        await _io.WaitAsync(ct);
        try
        {
            _config = next with
            {
                Host = string.IsNullOrWhiteSpace(next.Host) ? "127.0.0.1" : next.Host.Trim(),
                Port = next.Port is > 0 and < 65536 ? next.Port : 4533,
                PollingIntervalMs = Math.Clamp(next.PollingIntervalMs, 100, 10_000),
            };
            DisconnectLocked();
            lock (_state) { _currentAz = null; _targetAz = null; }
            _lastError = null;
            if (_configChanged.CurrentCount == 0) _configChanged.Release();
        }
        finally
        {
            _io.Release();
        }
        return GetStatus();
    }

    public async Task<RotctldStatus> SetAzAsync(double az, CancellationToken ct)
    {
        var normalized = ((az % 360) + 360) % 360;
        await _io.WaitAsync(ct);
        try
        {
            if (!_connected || _writer == null || _reader == null)
            {
                _lastError = "rotctld not connected";
                return GetStatus();
            }
            try
            {
                // Short-form: P <az> <el>. Zero elevation — we don't model a dual-axis rotator yet.
                await _writer.WriteAsync($"P {normalized.ToString("F2", CultureInfo.InvariantCulture)} 0\n");
                await _writer.FlushAsync(ct);
                var reply = await _reader.ReadLineAsync(ct);
                if (reply == null) throw new IOException("rotctld closed connection");
                if (!reply.StartsWith("RPRT 0", StringComparison.Ordinal))
                {
                    _lastError = $"rotctld P command: {reply}";
                }
                else
                {
                    _lastError = null;
                    lock (_state) { _targetAz = normalized; _lastCommandUtc = DateTime.UtcNow; }
                }
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                DisconnectLocked();
            }
        }
        finally
        {
            _io.Release();
        }
        return GetStatus();
    }

    public async Task<RotctldStatus> StopRotatorAsync(CancellationToken ct)
    {
        await _io.WaitAsync(ct);
        try
        {
            if (!_connected || _writer == null || _reader == null) return GetStatus();
            try
            {
                await _writer.WriteAsync("S\n");
                await _writer.FlushAsync(ct);
                _ = await _reader.ReadLineAsync(ct);
                lock (_state) { _targetAz = null; }
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                DisconnectLocked();
            }
        }
        finally
        {
            _io.Release();
        }
        return GetStatus();
    }

    public async Task<RotctldTestResult> TestAsync(string host, int port, CancellationToken ct)
    {
        try
        {
            using var tc = new TcpClient();
            using var dialCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            dialCts.CancelAfter(TimeSpan.FromSeconds(3));
            await tc.ConnectAsync(host, port, dialCts.Token);
            using var stream = tc.GetStream();
            using var sr = new StreamReader(stream, Encoding.ASCII);
            await using var sw = new StreamWriter(stream, Encoding.ASCII) { AutoFlush = true, NewLine = "\n" };
            await sw.WriteAsync("p\n");
            using var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            readCts.CancelAfter(TimeSpan.FromSeconds(2));
            var az = await sr.ReadLineAsync(readCts.Token);
            if (az == null) return new RotctldTestResult(false, "rotctld closed connection before reply");
            return new RotctldTestResult(true, null);
        }
        catch (Exception ex)
        {
            return new RotctldTestResult(false, ex.Message);
        }
    }

    private async Task RunLoop(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var cfg = _config;
            if (!cfg.Enabled)
            {
                try { await _configChanged.WaitAsync(stoppingToken); } catch (OperationCanceledException) { return; }
                continue;
            }

            if (!_connected)
            {
                await _io.WaitAsync(stoppingToken);
                try
                {
                    await ConnectLockedAsync(cfg, stoppingToken);
                }
                finally
                {
                    _io.Release();
                }

                if (!_connected)
                {
                    var delayTask = Task.Delay(ReconnectBackoff, stoppingToken);
                    var configTask = _configChanged.WaitAsync(stoppingToken);
                    await Task.WhenAny(delayTask, configTask);
                    continue;
                }
            }

            await _io.WaitAsync(stoppingToken);
            try
            {
                if (_connected && _writer != null && _reader != null)
                {
                    try
                    {
                        await _writer.WriteAsync("p\n");
                        await _writer.FlushAsync(stoppingToken);
                        var az = await _reader.ReadLineAsync(stoppingToken);
                        var el = await _reader.ReadLineAsync(stoppingToken);
                        if (az == null || el == null) throw new IOException("rotctld closed connection");
                        if (double.TryParse(az.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var azd))
                        {
                            lock (_state) { _currentAz = azd; }
                            _lastError = null;
                        }
                    }
                    catch (Exception ex)
                    {
                        _lastError = ex.Message;
                        DisconnectLocked();
                    }
                }
            }
            finally
            {
                _io.Release();
            }

            try { await Task.Delay(cfg.PollingIntervalMs, stoppingToken); } catch (OperationCanceledException) { return; }
        }
    }

    private async Task ConnectLockedAsync(RotctldConfig cfg, CancellationToken ct)
    {
        try
        {
            var tc = new TcpClient();
            using var dialCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            dialCts.CancelAfter(TimeSpan.FromSeconds(3));
            await tc.ConnectAsync(cfg.Host, cfg.Port, dialCts.Token);
            var stream = tc.GetStream();
            _client = tc;
            _reader = new StreamReader(stream, Encoding.ASCII);
            _writer = new StreamWriter(stream, Encoding.ASCII) { AutoFlush = false, NewLine = "\n" };
            _connected = true;
            _lastError = null;
            _log.LogInformation("rotctld connected {Host}:{Port}", cfg.Host, cfg.Port);
        }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            _connected = false;
            DisposeConnectionLocked();
        }
    }

    private void DisconnectLocked()
    {
        if (_connected) _log.LogInformation("rotctld disconnect");
        _connected = false;
        DisposeConnectionLocked();
    }

    private void DisposeConnectionLocked()
    {
        try { _writer?.Dispose(); } catch { /* ignore */ }
        try { _reader?.Dispose(); } catch { /* ignore */ }
        try { _client?.Dispose(); } catch { /* ignore */ }
        _writer = null;
        _reader = null;
        _client = null;
    }

    public async ValueTask DisposeAsync()
    {
        try { _loopCts?.Cancel(); } catch { /* ignore */ }
        if (_loopTask is not null)
        {
            try { await _loopTask; } catch { /* ignore */ }
        }
        DisposeConnectionLocked();
        _io.Dispose();
        _configChanged.Dispose();
        _loopCts?.Dispose();
    }

    private static double NormDelta(double d)
    {
        d = ((d % 360) + 360) % 360;
        return d > 180 ? d - 360 : d;
    }
}
