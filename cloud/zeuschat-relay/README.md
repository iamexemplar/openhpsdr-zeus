# zeuschat-relay

Cloudflare Worker + Durable Object relay for **ZeusChat** — operator-to-operator
chat for Zeus.

Every operator runs their own local Zeus backend, so there is no shared server.
This relay is the central meeting point: each Zeus backend opens one outbound
WebSocket here, asserts its QRZ-verified callsign, publishes live presence
(frequency / mode / status), and exchanges chat messages. The relay fans
messages and roster updates out to all connected operators.

It runs on the project's own Cloudflare account.

## Design

- **Backend is the chat node, not the browser.** The Zeus backend holds the
  QRZ-verified callsign and the live VFO frequency, so the relay connection
  stays server-side and the identity token never reaches a browser. The browser
  ChatPanel talks to its own backend over the existing StreamingHub/REST.
- **WebSocket Hibernation.** The `ChatRoom` Durable Object uses the hibernation
  API (`acceptWebSocket` + `webSocket*` handlers), so it can be evicted from
  memory while connections stay open. Roster is reconstructed from per-socket
  attachments. Keepalive `ping`/`pong` is handled by `setWebSocketAutoResponse`
  and does not wake the DO.
- **One room in P0** (`lobby`). Band-derived rooms arrive in P3.

## Wire protocol

Text WebSocket frames, one JSON object per frame, discriminated by `t`. The
authoritative definition lives in [`src/protocol.ts`](src/protocol.ts); the C#
side mirrors it.

Backend → relay: `hello`, `presence`, `msg`, `ping`
Relay → backend: `welcome`, `roster`, `msg`, `error`, `pong`

Connect to `wss://<host>/chat`. Auth is at the HTTP upgrade via headers:

- `Authorization: Bearer <secret>` (or `?token=<secret>`) if `RELAY_SHARED_SECRET` is set.
- `X-QRZ-Session: <live QRZ session key>` and `X-QRZ-Callsign: <own callsign>`
  when `QRZ_VERIFY` is on (the default). The relay validates the session against
  the QRZ XML API and locks the verified callsign for the connection.

The first frame is `hello` (presence: grid/freq/mode/status). Its `callsign` is
only used in local dev where `QRZ_VERIFY=off`.

## Develop locally

```bash
cd cloud/zeuschat-relay
npm install
npm run typecheck      # tsc --noEmit
npm run dev            # wrangler dev — serves on http://localhost:8787
```

Smoke test the health route:

```bash
curl http://localhost:8787/health      # -> "zeuschat-relay ok"
```

Smoke test the socket (any WS client), e.g. with `websocat`:

```bash
websocat ws://localhost:8787/chat
> {"t":"hello","callsign":"W1ABC","freq":14074000,"mode":"FT8"}
< {"t":"welcome", ...}
< {"t":"roster", ...}
```

## Deploy (project owner)

Requires a Cloudflare account with Workers + Durable Objects.

```bash
npm install
wrangler login
wrangler secret put RELAY_SHARED_SECRET   # optional but recommended
npm run deploy
```

`new_sqlite_classes` is used for the DO namespace, which is available on the
free Workers plan.

## Security notes

- **QRZ-login required.** With `QRZ_VERIFY` on (default), every connection must
  present a live QRZ session key, which the relay validates against the QRZ XML
  API before admitting. Only operators logged into QRZ can use chat. Works for
  any QRZ login tier (subscription not required). Fails closed if QRZ is
  unreachable.
- `RELAY_SHARED_SECRET` gates *who can reach the relay at all*; set it in
  production so the relay is not an open endpoint.
- **Callsign↔account binding is best-effort.** The QRZ session proves a valid
  login; QRZ XML does not cleanly prove which callsign owns that session, so a
  determined modified client could present a valid session under a different
  callsign. Tightening this is tracked in ZeusChat P4.
- Messages are capped at `MAX_MESSAGE_LEN` (2000 chars). Rate limiting lands in
  P3.
