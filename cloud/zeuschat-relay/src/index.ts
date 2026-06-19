import type { Env } from './types';
import { DEFAULT_ROOM } from './protocol';

export { ChatRoom } from './chat-room';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('zeuschat-relay ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }

    if (url.pathname === '/chat') {
      // 1. Shared-secret gate (set RELAY_SHARED_SECRET to enable).
      if (env.RELAY_SHARED_SECRET) {
        const header = request.headers.get('Authorization');
        const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        const token = bearer ?? url.searchParams.get('token') ?? undefined;
        if (token !== env.RELAY_SHARED_SECRET) {
          return new Response('unauthorized', { status: 401 });
        }
      }

      // 2. QRZ-login gate. The backend proves the operator is logged into QRZ
      //    by presenting its live QRZ session key + own callsign as headers; we
      //    validate the session against QRZ before admitting. Disable with
      //    QRZ_VERIFY="off" for local dev (browser WS clients can't set headers).
      const verify = (env.QRZ_VERIFY ?? 'on').toLowerCase() !== 'off';
      const callsign = (request.headers.get('X-QRZ-Callsign') ?? '').trim().toUpperCase();
      if (verify) {
        const sessionKey = request.headers.get('X-QRZ-Session') ?? '';
        if (!sessionKey || !callsign) {
          return new Response('qrz auth required', { status: 401 });
        }
        const ok = await verifyQrzSession(sessionKey, callsign);
        if (!ok) {
          return new Response('qrz session invalid or not logged in', { status: 403 });
        }
      }

      // 3. WebSocket upgrade required.
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 426 });
      }

      // 4. Route to the room DO, forwarding the (verified) callsign so the DO
      //    treats it as authoritative. P0: one global room.
      const headers = new Headers(request.headers);
      if (callsign) headers.set('X-Operator-Callsign', callsign);
      const forwarded = new Request(request, { headers });

      const id = env.CHAT_ROOM.idFromName(DEFAULT_ROOM);
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(forwarded);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Validates a QRZ XML session key by performing one lookup of the operator's
 * own callsign. Per the QRZ XML spec, a live session returns a <Key> element;
 * an expired/invalid session omits <Key> and returns <Error>Session Timeout</Error>.
 * Non-subscribers still get a <Key> (plus a subscription <Message>), so this
 * works for any QRZ login tier. Fails closed on any QRZ/network error.
 */
async function verifyQrzSession(sessionKey: string, callsign: string): Promise<boolean> {
  const u =
    'https://xmldata.qrz.com/xml/current/' +
    `?s=${encodeURIComponent(sessionKey)}` +
    `;callsign=${encodeURIComponent(callsign)}` +
    ';agent=zeuschat';
  try {
    const res = await fetch(u, { cf: { cacheTtl: 0 } });
    if (!res.ok) return false;
    const xml = await res.text();
    const hasKey = /<Key>\s*[^<\s][^<]*<\/Key>/i.test(xml);
    const errText = /<Error>([^<]*)<\/Error>/i.exec(xml)?.[1] ?? '';
    const badSession = /session timeout|invalid session|session expired|not logged/i.test(errText);
    return hasKey && !badSession;
  } catch {
    return false; // fail closed: no proof of login => no access
  }
}
