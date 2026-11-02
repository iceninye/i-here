/**
 * liveShare 純函數測試（§5.2.1 / §5.3）：
 *  - join link 嘅 roomId + key 只喺 **fragment**（唔入 search，唔會送去 server）；
 *  - 解析回嚟要一模一樣（WhatsApp / 短訊傳完再開）；
 *  - 缺 `k`（分享 App 剝走 `#` 後面）→ `key: null`，UI 顯示「連結唔完整」而唔係靜靜地連唔到。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLiveLink, createRoom, parseLiveFragment } from './liveShare';
import { b64urlToBytes, importKey } from './liveCrypto';

const BASE = 'https://i-here.example/';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildLiveLink / parseLiveFragment', () => {
  it('round-trips roomId and key through the fragment', () => {
    const link = buildLiveLink({ roomId: 'abc-123_XY', key: 'k-ey_456' }, BASE);
    expect(link).toBe('https://i-here.example/#live=abc-123_XY&k=k-ey_456');
    const parsed = parseLiveFragment(new URL(link).hash);
    expect(parsed).toEqual({ roomId: 'abc-123_XY', key: 'k-ey_456' });
  });

  it('keeps roomId and key out of the query string (server never sees them)', () => {
    const link = buildLiveLink({ roomId: 'room', key: 'secret' }, BASE);
    const u = new URL(link);
    expect(u.search).toBe('');
    expect(u.pathname).toBe('/');
    expect(u.hash).toContain('room');
    expect(u.hash).toContain('secret');
  });

  it('drops existing search params (e.g. ?at= / ?debug=1) from the invite link', () => {
    const link = buildLiveLink({ roomId: 'r', key: 'k' }, 'https://i-here.example/?at=22.3,114.1&debug=1');
    expect(link).toBe('https://i-here.example/#live=r&k=k');
  });

  it('returns null for an empty or unrelated hash', () => {
    expect(parseLiveFragment('')).toBeNull();
    expect(parseLiveFragment('#')).toBeNull();
    expect(parseLiveFragment('#foo=bar')).toBeNull();
  });

  it('reports a missing key as null (incomplete link, §5.2.1)', () => {
    expect(parseLiveFragment('#live=room-only')).toEqual({ roomId: 'room-only', key: null });
  });

  it('survives percent-encoding of unusual base64url characters', () => {
    const key = 'A-B_C'.repeat(8) + 'xyz';
    const link = buildLiveLink({ roomId: 'r1', key }, BASE);
    expect(parseLiveFragment(new URL(link).hash)?.key).toBe(key);
  });
});

describe('createRoom', () => {
  it('POSTs /api/live, generates a key and returns a parseable invite link', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ roomId: 'ROOM123', hostToken: 'TOKEN', expiresAt: 1234567890 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const room = await createRoom('https://worker.example');
    expect(fetchMock).toHaveBeenCalledWith('https://worker.example/api/live', { method: 'POST' });
    expect(room.roomId).toBe('ROOM123');
    expect(room.hostToken).toBe('TOKEN');
    expect(room.expiresAt).toBe(1234567890);

    // key 係 256-bit（base64url 43 字元），而且真係用得
    expect(room.key).toHaveLength(43);
    expect(b64urlToBytes(room.key)).toHaveLength(32);
    await expect(importKey(room.key)).resolves.toBeDefined();

    const parsed = parseLiveFragment(new URL(room.link).hash);
    expect(parsed).toEqual({ roomId: 'ROOM123', key: room.key });
  });

  it('throws when the worker rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    await expect(createRoom('https://worker.example')).rejects.toThrow(/429/);
  });
});

describe('LiveClient resends the last fix', () => {
  class FakeWS {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
    static all: FakeWS[] = [];
    readyState = 0; sent: any[] = [];
    onopen: (() => void) | null = null; onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
    constructor(public url: string, public protocols: string[]) { FakeWS.all.push(this); }
    send(s: string) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
  }

  it('re-sends the latest position after a reconnect, even if the GPS fix never changes', async () => {
    FakeWS.all = [];
    vi.stubGlobal('WebSocket', FakeWS);
    const { LiveClient } = await import('./liveShare');
    const { generateKey, exportKey } = await import('./liveCrypto');
    const key = await exportKey(await generateKey());
    const c = new LiveClient({ roomId: 'room-1', key, hostToken: 't', apiBase: 'https://x.example' });
    await c.connect();
    FakeWS.all[0].open();
    await c.sendFix({ lat: 22.3, lng: 114.1, accuracy: 10 });
    expect(FakeWS.all[0].sent.filter(m => m.type === 'fix')).toHaveLength(1);

    // 連線被系統斷咗（例如切去 WhatsApp）→ 退避後重連
    FakeWS.all[0].close();
    await vi.waitFor(() => expect(FakeWS.all).toHaveLength(2), { timeout: 3000, interval: 50 });
    FakeWS.all[1].open();
    await vi.waitFor(() => expect(FakeWS.all[1].sent.some(m => m.type === 'fix')).toBe(true), { timeout: 2000, interval: 20 });
    expect(FakeWS.all[1].sent[0]).toMatchObject({ type: 'hello', roomId: 'room-1', token: 't' });
    c.close();
  });
});
