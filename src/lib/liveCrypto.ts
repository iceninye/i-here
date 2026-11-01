/**
 * 實時分享 —— 端對端加密（PLAN §5.2.1，D7）。
 *
 * 設計：
 *  - **Key**：AES-GCM 256-bit，由建房嗰部機產生，匯出成 base64url（43 字元），**只放喺 link 嘅
 *    fragment**（`#live=<roomId>&k=<key>`）。Fragment 唔會送去 server，所以 Worker / Cloudflare
 *    都攞唔到 key。
 *  - **加密**：每條位置訊息加密 `{ seq, lat, lng, accuracy, speed?, heading?, ts }`（JSON）。
 *    每條用新嘅 96-bit 隨機 IV；`additionalData` = roomId（密文綁定個房，搬去另一個房解唔到）。
 *  - **重放 / 亂序**：`seq`（每個 sender 遞增）喺密文入面，完整性由 AES-GCM tag 驗證；
 *    收件人丟棄 `seq ≤ 已收最大值` 嘅訊息。
 *  - WebCrypto 要 secure context（HTTPS）；iOS Safari / Chrome 都支援。
 */

/** 一條位置訊息解密後嘅內容（server 永遠睇唔到呢啲） */
export interface LivePayload {
  seq: number;
  lat: number;
  lng: number;
  accuracy: number;
  speed?: number;
  heading?: number;
  /** sender 裝置時鐘（僅參考）；新舊判斷用 server 嘅 serverTs */
  ts: number;
}

const ALGO = 'AES-GCM';
const KEY_BITS = 256;
const IV_BYTES = 12; // 96-bit，GCM 標準

/* ---------------- base64url ---------------- */

export function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(str: string): Uint8Array<ArrayBuffer> {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- key ---------------- */

/** 產生新 AES-GCM 256 key（可匯出） */
export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: ALGO, length: KEY_BITS }, true, ['encrypt', 'decrypt']);
}

/** CryptoKey → base64url（放 link fragment） */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToB64url(new Uint8Array(raw));
}

/** base64url → CryptoKey（加入者由 fragment 還原） */
export async function importKey(b64url: string): Promise<CryptoKey> {
  const raw = b64urlToBytes(b64url);
  if (raw.length !== KEY_BITS / 8) throw new Error('bad key length');
  return crypto.subtle.importKey('raw', raw, { name: ALGO, length: KEY_BITS }, true, ['encrypt', 'decrypt']);
}

/* ---------------- encrypt / decrypt ---------------- */

function enc(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  // TextEncoder 回 Uint8Array<ArrayBufferLike>；WebCrypto 要 ArrayBuffer backed，所以複製一次
  const dst = new Uint8Array(new ArrayBuffer(src.byteLength));
  dst.set(src);
  return dst;
}

/** 加密結果：`{ iv, ct }` 都係 base64url，直接放入 WS 訊息 */
export interface EncryptedFix {
  iv: string;
  ct: string;
}

/**
 * 加密一條位置訊息。每條用新嘅隨機 IV；`roomId` 做 additionalData（綁定個房）。
 */
export async function encryptFix(key: CryptoKey, roomId: string, payload: LivePayload): Promise<EncryptedFix> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const ctBuf = await crypto.subtle.encrypt(
    { name: ALGO, iv, additionalData: enc(roomId) },
    key,
    enc(JSON.stringify(payload)),
  );
  return { iv: bytesToB64url(iv), ct: bytesToB64url(new Uint8Array(ctBuf)) };
}

/**
 * 解密一條位置訊息。以下情況會 throw（呼叫方應丟棄該訊息，唔好 crash）：
 *  - 密文 / IV 被竄改（GCM tag 驗證失敗）
 *  - 用錯 key
 *  - 用錯 roomId（additionalData 唔 match）
 */
export async function decryptFix(key: CryptoKey, roomId: string, msg: EncryptedFix): Promise<LivePayload> {
  const iv = b64urlToBytes(msg.iv);
  const ct = b64urlToBytes(msg.ct);
  const ptBuf = await crypto.subtle.decrypt({ name: ALGO, iv, additionalData: enc(roomId) }, key, ct);
  const obj = JSON.parse(new TextDecoder().decode(ptBuf)) as LivePayload;
  // 收件人先驗證座標範圍（server 解唔到，唔驗證；§5.2）
  if (!isValidPayload(obj)) throw new Error('invalid payload');
  return obj;
}

/** 解密後嘅合法性檢查（§5.2）：座標 / 精度範圍 */
export function isValidPayload(p: unknown): p is LivePayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.lat === 'number' && o.lat >= -90 && o.lat <= 90 &&
    typeof o.lng === 'number' && o.lng >= -180 && o.lng <= 180 &&
    typeof o.accuracy === 'number' && o.accuracy >= 0 &&
    typeof o.seq === 'number' && Number.isInteger(o.seq) &&
    typeof o.ts === 'number'
  );
}

/* ---------------- 重放保護 ---------------- */

/**
 * 每個 sender 一個：記住已收最大 seq，丟棄 `seq ≤ max`（重放 / 亂序舊訊）。
 * seq 喺密文入面，完整性由 GCM 保證，所以呢個檢查係安全嘅。
 */
export function createReplayGuard() {
  const seen = new Map<string, number>();
  return {
    /** 回 true = 接受（並記低）；false = 丟棄（重放 / 舊訊） */
    accept(from: string, seq: number): boolean {
      const prev = seen.get(from);
      if (prev !== undefined && seq <= prev) return false;
      seen.set(from, seq);
      return true;
    },
    reset(from?: string) {
      if (from === undefined) seen.clear();
      else seen.delete(from);
    },
  };
}
