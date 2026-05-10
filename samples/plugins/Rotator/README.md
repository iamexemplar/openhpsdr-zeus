# Rotator (rotctld) plugin

First-party Zeus plugin: a hamlib `rotctld` client. Persistent TCP socket
to a running `rotctld` daemon, polls the rotor's azimuth at a configurable
interval, and exposes set / stop / test commands.

## Wire surface

The plugin owns the entire `/api/rotator/*` namespace:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/api/rotator/status` | Current connection + azimuth snapshot |
| `POST` | `/api/rotator/config` | Update host/port/poll interval; reconnects |
| `POST` | `/api/rotator/set`    | Slew to a target azimuth |
| `POST` | `/api/rotator/stop`   | Stop in-flight movement |
| `POST` | `/api/rotator/test`   | One-shot probe of an arbitrary host:port |

The wire DTOs (`RotctldConfig`, `RotctldStatus`, …) live in `Zeus.Contracts`
and are unchanged from the in-tree predecessor — the existing frontend
under `zeus-web/src/api/rotator.ts` keeps working as-is.

## Capabilities

`NetworkAccess` — required, declared in `plugin.json`. The plugin's
`InitializeAsync` refuses to start if the host doesn't grant it.

## Why a plugin?

Antenna rotators are an optional feature: only operators with one in the
shack need this. Pulling it out of `Zeus.Server.Hosting` shrinks the core
and validates the plugin extension model with a non-trivial real-world
example (TCP client, background polling loop, capability declaration,
HTTP endpoints).

## Build & install

`dotnet build` — output drops into `bin/<Configuration>/net10.0/` and is
copied next to `Zeus.Server.dll` under `plugins/Rotator/` by the
`CopyToHostPluginDir` MSBuild target on `Zeus.Server.csproj`.
