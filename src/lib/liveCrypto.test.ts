import { describe, expect, it } from 'vitest';
import {
  b64urlToBytes, bytesToB64url, createReplayGuard, decryptFix, encryptFix,
  exportKey, generateKey, importKey, isValidPayload, type LivePayload,
} from './liveCrypto';

const ROOM = 'test-room-id-123';
const sample: LivePayload = { seq: 1, lat: 22.3193, lng: 114.1694, accuracy: 8, speed: 1.2, heading: 90, ts: 1000 };

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [0, 1, 12, 16, 32]) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      expect(bytesToB64url(b64urlToBytes(bytesToB64url(bytes)))).toEqual(bytesToB64url(bytes));
      expect(b64urlToBytes(bytesToB64url(bytes))).toEqual(bytes);
    }
  });
  it('produces url-safe chars (no +/=)', () => {
    const s = bytesToB64url(new Uint8Array([255, 254, 253, 252, 251]));
    expect(s).not.toMatch(/[+/=]/);
  });
});

describe('key import/export', () => {
  it('exports a 43-char base64url key that re-imports', async () => {
    const key = await generateKey();
    const b64 = await exportKey(key);
    expect(b64).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 chars
    const back = await importKey(b64);
    expect(await exportKey(back)).toBe(b64);
  });
  it('rejects a wrong-length key', async () => {
    await expect(importKey(bytesToB64url(new Uint8Array(16)))).rejects.toThrow();
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('recovers the exact payload', async () => {
    const key = await generateKey();
    const msg = await encryptFix(key, ROOM, sample);
    const out = await decryptFix(key, ROOM, msg);
    expect(out).toEqual(sample);
  });

  it('uses a fresh IV per message (same payload → different ciphertext)', async () => {
    const key = await generateKey();
    const a = await encryptFix(key, ROOM, sample);
    const b = await encryptFix(key, ROOM, sample);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('works across export/import (host encrypts, guest imports key from fragment)', async () => {
    const hostKey = await generateKey();
    const msg = await encryptFix(hostKey, ROOM, sample);
    const guestKey = await importKey(await exportKey(hostKey));
    expect(await decryptFix(guestKey, ROOM, msg)).toEqual(sample);
  });
});

describe('decryption failures (must throw → caller discards)', () => {
  it('fails when a ciphertext byte is tampered', async () => {
    const key = await generateKey();
    const msg = await encryptFix(key, ROOM, sample);
    const ctBytes = b64urlToBytes(msg.ct);
    ctBytes[0] ^= 0xff; // flip a byte → GCM tag mismatch
    await expect(decryptFix(key, ROOM, { iv: msg.iv, ct: bytesToB64url(ctBytes) })).rejects.toThrow();
  });

  it('fails with the wrong key', async () => {
    const key = await generateKey();
    const wrong = await generateKey();
    const msg = await encryptFix(key, ROOM, sample);
    await expect(decryptFix(wrong, ROOM, msg)).rejects.toThrow();
  });

  it('fails with the wrong roomId (additionalData binds ciphertext to the room)', async () => {
    const key = await generateKey();
    const msg = await encryptFix(key, ROOM, sample);
    await expect(decryptFix(key, 'another-room', msg)).rejects.toThrow();
  });
});

describe('payload validation (§5.2 receiver-side)', () => {
  it('rejects out-of-range / malformed payloads', () => {
    expect(isValidPayload({ ...sample })).toBe(true);
    expect(isValidPayload({ ...sample, lat: 91 })).toBe(false);
    expect(isValidPayload({ ...sample, lng: -181 })).toBe(false);
    expect(isValidPayload({ ...sample, accuracy: -1 })).toBe(false);
    expect(isValidPayload({ ...sample, seq: 1.5 })).toBe(false);
    expect(isValidPayload(null)).toBe(false);
    expect(isValidPayload({ lat: 1 })).toBe(false);
  });
});

describe('replay guard (§5.2.1)', () => {
  it('accepts increasing seq, discards replays and out-of-order old messages', () => {
    const g = createReplayGuard();
    expect(g.accept('peerA', 1)).toBe(true);
    expect(g.accept('peerA', 2)).toBe(true);
    expect(g.accept('peerA', 2)).toBe(false); // replay
    expect(g.accept('peerA', 1)).toBe(false); // old
    expect(g.accept('peerA', 5)).toBe(true); // jump ahead ok
    expect(g.accept('peerA', 3)).toBe(false); // out-of-order old
  });
  it('tracks senders independently', () => {
    const g = createReplayGuard();
    expect(g.accept('A', 10)).toBe(true);
    expect(g.accept('B', 1)).toBe(true); // B unaffected by A
  });
  it('reset clears state', () => {
    const g = createReplayGuard();
    g.accept('A', 5);
    g.reset('A');
    expect(g.accept('A', 1)).toBe(true);
  });
});
