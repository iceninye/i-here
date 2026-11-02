/**
 * LiveShareRoom DO + Worker 整合測試（PLAN §5.5）。
 * 跑喺 workerd（@cloudflare/vitest-pool-workers）：
 *  - `SELF.fetch(url, { headers: { Upgrade: 'websocket' } })` → 101 response，`res.webSocket` 係 client 端。
 *  - roomId 經 `Sec-WebSocket-Protocol` 傳（唔入 URL）—— 呢個係本測試要驗證嘅關鍵架構。
 *  - `runInDurableObject(stub, …)` 直接讀 DO storage，驗證冇座標（D9）。
 *  - `runDurableObjectAlarm(stub)` 觸發 TTL / 心跳 sweep。
 */

import { SELF, env, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 開一個 WebSocket（client 端），用 subprotocol 帶 roomId。回 ws + 收集到嘅訊息。 */
async function openSocket(roomId: string): Promise<{ ws: WebSocket; messages: any[] }> {
  const res = await SELF.fetch('https://test/api/live/ws', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `ih-live, ${roomId}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: any[] = [];
  ws.addEventListener('message', e => { messages.push(JSON.parse(String(e.data))); });
  ws.accept();
  return { ws, messages };
}

/** 開 socket 並 hello */
async function connect(roomId: string, token?: string) {
  const s = await openSocket(roomId);
  s.ws.send(JSON.stringify({ type: 'hello', roomId, ...(token ? { token } : {}) }));
  await wait(30);
  return s;
}

async function createRoom() {
  const res = await SELF.fetch('https://test/api/live', { method: 'POST' });
  expect(res.status).toBe(200);
  return (await res.json()) as { roomId: string; hostToken: string; expiresAt: number };
}

function stubFor(roomId: string) {
  return env.LIVE_SHARE.get(env.LIVE_SHARE.idFromName(roomId));
}

describe('POST /api/live', () => {
  it('creates a room with a 128-bit roomId and a hostToken', async () => {
    const { roomId, hostToken, expiresAt } = await createRoom();
    expect(roomId).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url ≈ 22 chars
    expect(hostToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('WebSocket routing + handshake', () => {
  it('routes via subprotocol (roomId NOT in URL) and echoes it so the browser handshake succeeds', async () => {
    const { roomId } = await createRoom();
    const res = await SELF.fetch('https://test/api/live/ws', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `ih-live, ${roomId}` },
    });
    expect(res.status).toBe(101);
    // DO echo 返 client offered 嘅 subprotocol（roomId）→ browser 唔會 abort handshake
    expect(res.headers.get('Sec-WebSocket-Protocol')).toContain(roomId);
    // roomId 冇出現喺 URL
    expect('https://test/api/live/ws').not.toContain(roomId);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it('rejects an upgrade with no room subprotocol (cannot route)', async () => {
    const res = await SELF.fetch('https://test/api/live/ws', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(400);
  });
});

describe('WebSocket relay', () => {
  it('relays ciphertext fixes between two peers without parsing coordinates', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    const guest = await connect(roomId);
    await wait(30);

    // host 見到 guest joined
    expect(host.messages.some(m => m.type === 'peer')).toBe(true);

    const ct = 'Zm9vYmFyLWNpcGhlcg'; // 亂數「密文」，DO 解唔到
    guest.ws.send(JSON.stringify({ type: 'fix', iv: 'aXYxMg', ct }));
    await wait(50);

    const relayed = host.messages.find(m => m.type === 'fix');
    expect(relayed).toBeDefined();
    expect(relayed.ct).toBe(ct); // 原封不動中轉
    expect(relayed.serverTs).toBeGreaterThan(0);
    expect(JSON.stringify(relayed)).not.toMatch(/"lat"|"lng"/);

    host.ws.close(); guest.ws.close();
  });

  it('answers ping with a serverTs pong so clients can measure relay latency (§5.5)', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);

    host.ws.send(JSON.stringify({ type: 'ping' }));
    await wait(30);

    const pong = host.messages.find(m => m.type === 'pong');
    expect(pong).toBeDefined();
    expect(typeof pong.serverTs).toBe('number');
    expect(Math.abs(pong.serverTs - Date.now())).toBeLessThan(5000);

    host.ws.close();
  });

  it('rejects a third peer (room full)', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    const guest = await connect(roomId);
    const third = await connect(roomId);
    await wait(50);
    expect(third.messages.some(m => m.type === 'ended' && m.reason === 'full')).toBe(true);
    host.ws.close(); guest.ws.close(); third.ws.close();
  });

  it('ends the room for everyone when a peer sends stop', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    const guest = await connect(roomId);
    host.ws.send(JSON.stringify({ type: 'stop' }));
    await wait(50);
    expect(guest.messages.some(m => m.type === 'ended' && m.reason === 'stop')).toBe(true);
  });

  it('closes a peer that sends an oversized message', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    host.ws.send(JSON.stringify({ type: 'fix', iv: 'x'.repeat(600), ct: 'y' }));
    await wait(50);
    expect(host.ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it('closes a peer that sends before hello', async () => {
    const { roomId } = await createRoom();
    const s = await openSocket(roomId);
    s.ws.send(JSON.stringify({ type: 'fix', iv: 'a', ct: 'b' }));
    await wait(40);
    expect(s.ws.readyState).not.toBe(WebSocket.OPEN);
  });
});

describe('no coordinate persistence (D9, §5.5)', () => {
  it('stores only room metadata after relaying fixes — no lat/lng', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    const guest = await connect(roomId);
    guest.ws.send(JSON.stringify({ type: 'fix', iv: 'aXY', ct: 'Y2lwaGVy' }));
    await wait(50);

    const stored = await runInDurableObject(stubFor(roomId), (_inst, state) => state.storage.list());
    const keys = [...stored.keys()];
    // 只應該有 'meta'（roomId/hostToken/expiresAt）；座標從來冇入 storage
    expect(keys).toContain('meta');
    expect(keys.some(k => /lat|lng|coord|fix/i.test(k))).toBe(false);

    const meta = await runInDurableObject(stubFor(roomId), (_i, s) => s.storage.get('meta'));
    expect(JSON.stringify(meta)).not.toMatch(/lat|lng/i);

    host.ws.close(); guest.ws.close();
  });
});

describe('TTL alarm (§5.2)', () => {
  it('ends the room with reason ttl when the alarm fires past expiry', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    // 將 expiresAt 推到過去
    await runInDurableObject(stubFor(roomId), (_i, s) =>
      s.storage.put('meta', { roomId, hostToken, expiresAt: Date.now() - 1000 }),
    );
    // Evict DO：清走 in-memory meta 快取，令 alarm 由 storage 重新載入（現實路徑：DO 被 evict 後 alarm 先觸發）。
    // hibernatable WebSocket 會保留連接。
    await evictDurableObject(stubFor(roomId));
    await runDurableObjectAlarm(stubFor(roomId));
    await wait(30);
    expect(host.messages.some(m => m.type === 'ended' && m.reason === 'ttl')).toBe(true);
  });
});

describe('review fixes', () => {
  it('allows same-origin and the configured Pages origin, rejects others (Origin check)', async () => {
    const post = (origin: string) => SELF.fetch('https://test/api/live', { method: 'POST', headers: { Origin: origin } });
    expect((await post('https://test')).status).toBe(200);
    expect((await post('https://evil.example')).status).toBe(403);
    const res = await SELF.fetch('https://test/api/live', { method: 'POST', headers: { Origin: 'https://iceninye.github.io' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://iceninye.github.io');
  });

  it('first alarm is the heartbeat sweep, not the TTL', async () => {
    const { roomId, expiresAt } = await createRoom();
    const alarm = await runInDurableObject(stubFor(roomId), async (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect((alarm as number)).toBeLessThan(Date.now() + 15_000);
    expect((alarm as number)).toBeLessThan(expiresAt);
  });

  it('refuses a websocket upgrade for a roomId that was never created', async () => {
    const res = await SELF.fetch('https://test/api/live/ws', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ih-live, AAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.status).toBe(404);
  });

  it('rejects a malformed roomId before touching a Durable Object', async () => {
    const res = await SELF.fetch('https://test/api/live/ws', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ih-live, not-a-room' },
    });
    expect(res.status).toBe(400);
  });

  it('locks the room after a kick: the same link cannot rejoin, the host still can', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    const guest = await connect(roomId);
    const guestId = host.messages.filter(m => m.type === 'peer' && m.state === 'joined').pop().id;
    host.ws.send(JSON.stringify({ type: 'kick', peerId: guestId }));
    await wait(50);
    const again = await connect(roomId);
    expect(again.messages.some(m => m.type === 'ended' && m.reason === 'kicked')).toBe(true);
    const hostAgain = await connect(roomId, hostToken);
    expect(hostAgain.messages.some(m => m.type === 'ended')).toBe(false);
    void guest;
  });
});

describe('peer list correctness', () => {
  it('does not echo a peer its own id (otherwise the other side lists "me" as 對方)', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = await connect(roomId, hostToken);
    const guest = await connect(roomId);
    host.ws.send(JSON.stringify({ type: 'fix', iv: 'aaaaaaaaaaaa', ct: 'bbbb' }));
    guest.ws.send(JSON.stringify({ type: 'fix', iv: 'cccccccccccc', ct: 'dddd' }));
    await wait(80);
    const ids = (m: any[]) => new Set(m.filter(x => x.type === 'peer').map(x => x.id));
    expect(ids(host.messages).size).toBe(1);
    expect(ids(guest.messages).size).toBe(1);
    expect([...ids(host.messages)][0]).not.toBe([...ids(guest.messages)][0]);
  });
});

describe('same-client reconnect', () => {
  it('lets a client with the same cid replace its stale socket instead of being rejected as a third peer', async () => {
    const { roomId, hostToken } = await createRoom();
    const helloWith = async (cid: string, token?: string) => {
      const s = await openSocket(roomId);
      s.ws.send(JSON.stringify({ type: 'hello', roomId, cid, ...(token ? { token } : {}) }));
      await wait(40);
      return s;
    };
    const host = await helloWith('hostclient', hostToken);
    const guest = await helloWith('guestclient');
    // guest 條舊 socket 半死（冇 close），佢重連：應該頂替而唔係 'full'
    const guest2 = await helloWith('guestclient');
    expect(guest2.messages.some(m => m.type === 'ended')).toBe(false);
    expect(host.messages.some(m => m.type === 'peer' && m.state === 'left')).toBe(true);
    expect(guest2.messages.some(m => m.type === 'peers' && m.count === 2)).toBe(true);
    void guest;
  });
});
