/**
 * 實時分享 client（PLAN §5.3）。
 *
 *  - Join link 用 **fragment**：`#live=<roomId>&k=<key>`（key 唔會送去 server；§5.2.1）。
 *  - WebSocket 連線：roomId 經 `Sec-WebSocket-Protocol` 傳（唔入 URL），配合 Worker / DO 路由。
 *  - 位置訊息用 liveCrypto 加密；收件人解密 + 重放保護 + 座標驗證。
 *  - 斷線指數退避重連；房散 / 過期 → onEnd。
 *
 * 呢個檔只做「傳輸 + 加解密」，唔碰 React state（嗰啲喺 useLiveShare.ts）。
 */

import { LIVE_API } from '../config';
import {
  createReplayGuard, decryptFix, encryptFix, exportKey, generateKey, importKey,
  type EncryptedFix, type LivePayload,
} from './liveCrypto';

/* ---------------- fragment link ---------------- */

export interface LiveLinkParts {
  roomId: string;
  key: string;
}

/** 建 join link：base（通常 location.origin+pathname）+ `#live=<roomId>&k=<key>` */
export function buildLiveLink(parts: LiveLinkParts, base = typeof location !== 'undefined' ? location.href : ''): string {
  const u = new URL(base || 'https://example.invalid/');
  u.search = '';
  u.hash = `live=${encodeURIComponent(parts.roomId)}&k=${encodeURIComponent(parts.key)}`;
  return u.toString();
}

/** 解析 `#live=<roomId>&k=<key>`。缺 k → 回 `{ roomId, key: null }`（UI 顯示「連結唔完整」；§5.2.1） */
export function parseLiveFragment(hash: string): { roomId: string; key: string | null } | null {
  const h = hash.replace(/^#/, '');
  if (!h) return null;
  const p = new URLSearchParams(h);
  const roomId = p.get('live');
  if (!roomId) return null;
  return { roomId, key: p.get('k') };
}

/* ---------------- room creation ---------------- */

export interface CreatedRoom extends LiveLinkParts {
  hostToken: string;
  expiresAt: number;
  link: string;
}

/** POST /api/live 建房；產生 E2EE key，回 roomId + hostToken + join link（key 喺 fragment） */
export async function createRoom(apiBase = LIVE_API): Promise<CreatedRoom> {
  const res = await fetch(`${apiBase}/api/live`, { method: 'POST' });
  if (!res.ok) throw new Error(`create room failed: ${res.status}`);
  const j = (await res.json()) as { roomId: string; hostToken: string; expiresAt: number };
  const key = await generateKey();
  const keyB64 = await exportKey(key);
  return {
    roomId: j.roomId,
    hostToken: j.hostToken,
    expiresAt: j.expiresAt,
    key: keyB64,
    link: buildLiveLink({ roomId: j.roomId, key: keyB64 }),
  };
}

/* ---------------- WS client ---------------- */

/** client → server 訊息（位置係密文；控制訊息明文，無位置） */
type ClientMsg =
  | { type: 'hello'; roomId: string; token?: string; cid?: string }
  | ({ type: 'fix' } & EncryptedFix)
  | { type: 'ping' } | { type: 'paused' } | { type: 'resume' } | { type: 'stop' }
  | { type: 'kick'; peerId: string };

/** 房散原因（server 話事）：用戶停止 / TTL 到期 / 房冇人 / 被踢 / 房滿 */
export type EndReason = 'stop' | 'ttl' | 'closed' | 'kicked' | 'full';

/** server → client 訊息 */
export type ServerMsg =
  | { type: 'peer'; id: string; state: 'joined' | 'live' | 'paused' | 'lost' | 'left' }
  | { type: 'fix'; from: string; iv: string; ct: string; serverTs: number }
  | { type: 'peers'; count: number }
  | { type: 'pong'; serverTs: number }
  | { type: 'ended'; reason: EndReason };

export type PeerState = 'joined' | 'live' | 'paused' | 'lost' | 'left';

/**
 * 延遲量度（§5.5：server 中轉延遲 p95 < 300 ms）。
 * client 同 server 鐘唔同步，所以用 `ping` / `pong` 做 NTP 式估算：
 *   RTT = 本地收到 pong − 送 ping；鐘差 offset ≈ (送 ping 時刻 + RTT/2) − serverTs；
 *   中轉延遲 = 本地收到 fix − (fix 嘅 serverTs + offset)。
 * 只係估算（誤差 ~RTT/2 嘅不對稱），但足夠判斷有冇超出 300 ms 目標。
 */
export interface LiveStats {
  rttMs: number | null;
  relayLastMs: number | null;
  relayP95Ms: number | null;
  samples: number;
}

export interface LiveClientHandlers {
  /** 解密成功、通過重放 + 座標驗證嘅對方位置 */
  onFix?: (from: string, payload: LivePayload, serverTs: number) => void;
  onPeer?: (id: string, state: PeerState) => void;
  onPeerCount?: (count: number) => void;
  /** 連線成功（hello 已送出） */
  onOpen?: () => void;
  onEnd?: (reason: EndReason) => void;
  /** 每次收到對方 fix 之後回報延遲統計（debug 面板用；§5.5） */
  onStats?: (stats: LiveStats) => void;
  /** 解密失敗 / 重放丟棄（除錯用，唔應該 crash） */
  onDiscard?: (reason: string) => void;
}

export interface LiveClientOptions {
  roomId: string;
  /** base64url key（建房者用自己產生嗰條；加入者由 fragment 攞） */
  key: string;
  /** 建房者先有；加入者留空 */
  hostToken?: string;
  /** 連線身份（同一個 client 重連時 server 用嚟頂替舊連線） */
  clientId?: string;
  apiBase?: string;
  handlers?: LiveClientHandlers;
}

/**
 * 一條 live share WebSocket 連線。負責：hello、加密送 fix、解密收 fix、心跳、斷線重連。
 * 呼叫方（hook）用 sendFix / stop / setPaused 控制。
 */
export class LiveClient {
  private ws: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private seq = 0;
  private replay = createReplayGuard();
  private closedByUser = false;
  private retry = 0;
  private pingSentAt = 0;
  /** 上一條送出嘅訊息時刻：server 限每 peer 2 條 / s（§5.2），fix 本身已算心跳 */
  private lastMsgAt = 0;
  /** 最後一次送出嘅位置（未加密）：重連 / 返前景 / 定位靜止時重送，確保對方一定有最新位置 */
  private lastFixSrc: { lat: number; lng: number; accuracy: number; speed?: number; heading?: number } | null = null;
  private tick = 0;
  private rttMs: number | null = null;
  /** 本地鐘 − server 鐘（ms） */
  private clockOffset = 0;
  private hasOffset = false;
  private relay: number[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<Pick<LiveClientOptions, 'roomId' | 'apiBase'>> & LiveClientOptions;

  constructor(opts: LiveClientOptions) {
    this.opts = { apiBase: LIVE_API, ...opts } as typeof this.opts;
  }

  /** 由 WS base（http→ws）砌 upgrade URL；roomId 放 subprotocol，唔入 URL */
  private wsUrl(): string {
    const base = this.opts.apiBase || (typeof location !== 'undefined' ? location.origin : '');
    return base.replace(/^http/, 'ws') + '/api/live/ws';
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    if (!this.key) this.key = await importKey(this.opts.key);
    // roomId 經 subprotocol 傳（browser WebSocket API 唔畀 set 自訂 header，又唔想入 URL）
    this.ws = new WebSocket(this.wsUrl(), ['ih-live', this.opts.roomId]);

    this.ws.onopen = () => {
      this.retry = 0;
      const hello: ClientMsg = { type: 'hello', roomId: this.opts.roomId };
      if (this.opts.hostToken) hello.token = this.opts.hostToken;
      if (this.opts.clientId) hello.cid = this.opts.clientId;
      this.rawSend(hello);
      // 重連 = server 當你係新 peer，冇你嘅 last fix；定位靜止就唔會有新 fix → 對方永遠睇唔到你。即刻補送。
      if (this.lastFixSrc) void this.sendFix(this.lastFixSrc);
      this.startPing();
      this.opts.handlers?.onOpen?.();
    };

    this.ws.onmessage = ev => {
      let msg: ServerMsg;
      try { msg = JSON.parse(String(ev.data)) as ServerMsg; }
      catch { return; }
      void this.handleServer(msg);
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => { /* onclose 會跟住觸發重連 */ };
  }

  private async handleServer(msg: ServerMsg): Promise<void> {
    switch (msg.type) {
      case 'fix': {
        if (!this.key) return;
        // 自己送出嘅 fix 唔會 broadcast 返俾自己（DO except=sender），但保險起見跳過
        let payload: LivePayload;
        try {
          payload = await decryptFix(this.key, this.opts.roomId, { iv: msg.iv, ct: msg.ct });
        } catch {
          this.opts.handlers?.onDiscard?.('decrypt-failed');
          return; // 竄改 / 錯 key / 錯房 → 丟棄
        }
        if (!this.replay.accept(msg.from, payload.seq)) {
          this.opts.handlers?.onDiscard?.('replay');
          return;
        }
        if (this.hasOffset) {
          const relayMs = Date.now() - (msg.serverTs + this.clockOffset);
          // 負數（鐘差估算誤差）同離譜值都唔入樣本
          if (relayMs >= -50 && relayMs < 60000) {
            this.relay.push(relayMs);
            if (this.relay.length > 60) this.relay.shift();
          }
        }
        this.opts.handlers?.onFix?.(msg.from, payload, msg.serverTs);
        this.opts.handlers?.onStats?.(this.getStats());
        break;
      }
      case 'pong': {
        if (this.pingSentAt) {
          const now = Date.now();
          this.rttMs = now - this.pingSentAt;
          this.clockOffset = (this.pingSentAt + this.rttMs / 2) - msg.serverTs;
          this.hasOffset = true;
          this.pingSentAt = 0;
        }
        break;
      }
      case 'peer': this.opts.handlers?.onPeer?.(msg.id, msg.state); break;
      case 'peers': this.opts.handlers?.onPeerCount?.(msg.count); break;
      case 'ended':
        this.opts.handlers?.onEnd?.(msg.reason);
        this.close(); // 房散咗，唔好重連
        break;
    }
  }

  /** 加密並送一個 fix。回 false = 未連上 / 加密失敗（呼叫方可略過） */
  async sendFix(f: { lat: number; lng: number; accuracy: number; speed?: number; heading?: number }): Promise<boolean> {
    this.lastFixSrc = f;
    if (!this.key || this.ws?.readyState !== WebSocket.OPEN) return false;
    const payload: LivePayload = { seq: ++this.seq, lat: f.lat, lng: f.lng, accuracy: f.accuracy, ts: Date.now() };
    if (f.speed !== undefined) payload.speed = f.speed;
    if (f.heading !== undefined) payload.heading = f.heading;
    try {
      const enc = await encryptFix(this.key, this.opts.roomId, payload);
      this.rawSend({ type: 'fix', ...enc });
      return true;
    } catch {
      return false;
    }
  }

  /** 最新延遲統計；未有樣本時 relay 係 null */
  getStats(): LiveStats {
    const sorted = [...this.relay].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
    return {
      rttMs: this.rttMs,
      relayLastMs: sorted.length ? this.relay[this.relay.length - 1] : null,
      relayP95Ms: p95 === null ? null : Math.round(p95),
      samples: this.relay.length,
    };
  }

  setPaused(paused: boolean): void {
    // 返前景：fix 本身就令 server 將你標返做 live，所以有位置就只送 fix（一條訊息，冇 resume + fix 連環兩條）；
    // 連線可能喺背景被系統斷咗又重連過，補送最新位置亦係為咗呢個
    if (!paused && this.lastFixSrc) { void this.sendFix(this.lastFixSrc); return; }
    this.rawSend({ type: paused ? 'paused' : 'resume' });
  }

  kick(peerId: string): void {
    this.rawSend({ type: 'kick', peerId });
  }

  /** 用戶主動停止：送 stop（關房）然後關連線，唔重連 */
  stop(): void {
    this.rawSend({ type: 'stop' });
    this.close();
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try { this.ws.close(1000, 'client close'); } catch { /* ignore */ }
    }
    this.ws = null;
  }

  private rawSend(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        this.lastMsgAt = Date.now();
      } catch { /* ignore */ }
    }
  }

  private startPing(): void {
    this.stopPing();
    // 每 4 s 一個 tick（§5.2：>10 s 冇訊息 server 當 lost）：單數 tick 送 ping 量延遲，
    // 雙數 tick 重送最新位置（定位靜止時瀏覽器唔會有新 fix，但對方仍然要見到「你喺度」）。
    // 啱啱送過訊息就跳過：server 限每 peer 2 條 / s。
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMsgAt < 1000) return;
      this.tick += 1;
      if (this.tick % 2 === 0 && this.lastFixSrc) { void this.sendFix(this.lastFixSrc); return; }
      this.pingSentAt = Date.now();
      this.rawSend({ type: 'ping' });
    }, 4000);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /** 指數退避重連：1s, 2s, 4s… 上限 15s */
  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(15000, 1000 * 2 ** this.retry);
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) void this.connect();
    }, delay);
  }
}
