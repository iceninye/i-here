/**
 * LiveShareRoom —— 一個 session = 一個 Durable Object 房間（PLAN §5.2）。
 *
 * 設計重點：
 *  - **DO 只中轉密文**：位置座標喺 client 用 AES-GCM 加密（§5.2.1），server 睇唔到 lat/lng。
 *    呢個檔嘅代碼路徑**永遠唔解析 `lat`/`lng`**，只做大小 / 頻率檢查同廣播。
 *  - **唔持久化座標**（D9）：`ctx.storage` 只存 `{ roomId, hostToken, expiresAt }`（無座標）。
 *    每個 peer 嘅 last fix（密文）放喺 WebSocket attachment（記憶體 / hibernation），唔落 storage。
 *  - **WebSocket Hibernation API**：`ctx.acceptWebSocket()`，DO 被 evict 後 WebSocket 仍然連住；
 *    peer 狀態用 `serializeAttachment` 保存，wake 時由 attachment 還原。
 *  - **身份**：建立者持 `hostToken`（`hello` 時帶）；加入者只有 `roomId`。冇 client 自報 role。
 *  - **TTL**：`ctx.storage.setAlarm()`，到期關房；alarm 同時做心跳 sweep（>10 s 冇訊息 → lost）。
 */

/** 一個 peer 喺 attachment 入面嘅狀態（隨 hibernation 保存，唔落 storage） */
interface PeerState {
  id: string;
  host: boolean;
  /** server 收到最後一個訊息嘅 epoch ms（心跳用） */
  lastSeen: number;
  state: 'joined' | 'live' | 'paused' | 'lost';
  /** 最後一個 fix（密文）—— 新 peer 加入 / 重連時即時補發 */
  lastFix?: { iv: string; ct: string; serverTs: number };
  /** 頻率限制 window */
  winStart: number;
  winCount: number;
}

/** storage 入面嘅房 metadata（無座標） */
interface RoomMeta {
  roomId: string;
  hostToken: string;
  /** epoch ms；alarm 到期關房 */
  expiresAt: number;
}

const MAX_PEERS = 2;
const MAX_MSG_BYTES = 512;
const MAX_MSG_PER_SEC = 2;
const LOST_AFTER_MS = 10_000;
const HEARTBEAT_SWEEP_MS = 10_000;
/** 全部 peer 斷線超過呢段時間 → 關房 */
const EMPTY_ROOM_CLOSE_MS = 60_000;
const DEFAULT_TTL_MS = 30 * 60_000;

type ServerMsg =
  | { type: 'peer'; id: string; state: PeerState['state'] | 'left' }
  | { type: 'fix'; from: string; iv: string; ct: string; serverTs: number }
  | { type: 'peers'; count: number }
  | { type: 'pong'; serverTs: number }
  | { type: 'ended'; reason: EndReason };

type EndReason = 'stop' | 'ttl' | 'closed' | 'kicked' | 'full';

function randToken(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  // base64url
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class LiveShareRoom {
  private meta: RoomMeta | null = null;
  /** 記憶體 map（awake 時用）；wake 後由 attachment 還原 */
  private peers = new Map<WebSocket, PeerState>();
  private emptySince: number | null = null;

  constructor(private ctx: DurableObjectState) {
    // hibernation：DO 被 evict 後重新 wake，從 attachment 還原 peer 狀態
    for (const ws of ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as PeerState | null;
      if (att) this.peers.set(ws, att);
    }
  }

  /* ---------------- HTTP：/init（建房）+ /ws（upgrade） ---------------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 400 });
      }
      const pair = new WebSocketPair();
      // Hibernation API：唔用 pair[1].accept()，用 ctx.acceptWebSocket()
      this.ctx.acceptWebSocket(pair[1]);
      // Echo 返 client 請求嘅 subprotocol（roomId 由呢度傳，唔入 URL —— 見 index.ts）。
      // browser 規定：server 冇 echo 其中一個 client offered subprotocol 就會 abort handshake。
      const offered = request.headers.get('Sec-WebSocket-Protocol');
      const headers = new Headers();
      if (offered) {
        const echo = offered.split(',').map(s => s.trim()).find(s => s && s !== 'ih-live') ?? 'ih-live';
        headers.set('Sec-WebSocket-Protocol', echo);
      }
      return new Response(null, { status: 101, webSocket: pair[0], headers });
    }

    if (url.pathname.endsWith('/init') && request.method === 'POST') {
      const existing = await this.ctx.storage.get<RoomMeta>('meta');
      if (existing) return Response.json({ error: 'already-initialized' }, { status: 409 });
      const roomId = url.searchParams.get('roomId') ?? '';
      if (!roomId) return new Response('missing roomId', { status: 400 });
      const meta: RoomMeta = { roomId, hostToken: randToken(), expiresAt: Date.now() + DEFAULT_TTL_MS };
      this.meta = meta;
      await this.ctx.storage.put('meta', meta);
      await this.ctx.storage.setAlarm(meta.expiresAt);
      return Response.json({ hostToken: meta.hostToken, expiresAt: meta.expiresAt });
    }

    return new Response('not found', { status: 404 });
  }

  private async ensureMeta(): Promise<RoomMeta | null> {
    if (this.meta) return this.meta;
    this.meta = (await this.ctx.storage.get<RoomMeta>('meta')) ?? null;
    return this.meta;
  }

  /* ---------------- WebSocket ---------------- */

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return this.close(ws, 1003, 'binary not allowed');
    if (raw.length > MAX_MSG_BYTES) return this.close(ws, 1009, 'message too large');

    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw) as Record<string, unknown>; }
    catch { return this.close(ws, 1002, 'invalid json'); }

    const peer = this.peers.get(ws);

    // 未 hello：只接受 hello
    if (!peer) {
      if (msg.type === 'hello') return this.handleHello(ws, msg);
      return this.close(ws, 1008, 'must hello first');
    }

    // 頻率限制：每 peer ≤ MAX_MSG_PER_SEC 條 / s
    const now = Date.now();
    if (now - peer.winStart >= 1000) { peer.winStart = now; peer.winCount = 0; }
    peer.winCount += 1;
    if (peer.winCount > MAX_MSG_PER_SEC) return this.close(ws, 1008, 'rate limit');
    peer.lastSeen = now;
    ws.serializeAttachment(peer);

    switch (msg.type) {
      case 'fix': return this.handleFix(ws, peer, msg);
      // lastSeen 已更新；回 pong 畀 client 量中轉延遲同鐘差（§5.5 p95 < 300 ms）
      case 'ping': return this.send(ws, { type: 'pong', serverTs: now });
      case 'paused': return this.setPeerState(ws, peer, 'paused');
      case 'resume': return this.setPeerState(ws, peer, 'live');
      case 'kick': return this.handleKick(ws, peer, msg);
      case 'stop': return this.endRoom('stop');
      default: return this.close(ws, 1002, 'unknown type');
    }
  }

  private async handleHello(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const meta = await this.ensureMeta();
    if (!meta) return this.close(ws, 1011, 'room not initialized');
    if (msg.roomId !== meta.roomId) return this.close(ws, 1008, 'wrong room');

    // 滿員：第三個連線直接拒絕（唔通知對方位置）
    const live = this.ctx.getWebSockets().filter(w => this.peers.has(w));
    if (live.length >= MAX_PEERS) {
      this.send(ws, { type: 'ended', reason: 'full' });
      return this.close(ws, 1013, 'room full');
    }

    const isHost = typeof msg.token === 'string' && msg.token === meta.hostToken;
    const peer: PeerState = {
      id: randToken(8),
      host: isHost,
      lastSeen: Date.now(),
      state: 'joined',
      winStart: Date.now(),
      winCount: 0,
    };
    this.peers.set(ws, peer);
    ws.serializeAttachment(peer);

    // 通知其他人「有人加入」+ 目前人數
    this.broadcast({ type: 'peer', id: peer.id, state: 'joined' }, ws);
    this.broadcastPeersCount();

    // 即時補發其他 peer 嘅 last fix（密文），新加入唔使等下一個 1 Hz
    for (const [other, st] of this.peers) {
      if (other === ws) continue;
      // 告訴新 peer 現有 peer 嘅狀態
      this.send(ws, { type: 'peer', id: st.id, state: st.state });
      if (st.lastFix) this.send(ws, { type: 'fix', from: st.id, iv: st.lastFix.iv, ct: st.lastFix.ct, serverTs: st.lastFix.serverTs });
    }
    // 房主身份告知自己（client 用來顯示「踢走」掣）
    this.send(ws, { type: 'peer', id: peer.id, state: 'joined' });
  }

  private handleFix(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>): void {
    const iv = msg.iv;
    const ct = msg.ct;
    // 只檢查型同大細；**唔解析內容**（密文）
    if (typeof iv !== 'string' || typeof ct !== 'string') return this.close(ws, 1002, 'bad fix');
    if (iv.length > 64 || ct.length > MAX_MSG_BYTES) return this.close(ws, 1009, 'fix too large');

    const serverTs = Date.now();
    peer.lastFix = { iv, ct, serverTs };
    // fix 視為心跳 → live
    if (peer.state !== 'live') { peer.state = 'live'; this.broadcast({ type: 'peer', id: peer.id, state: 'live' }); }
    ws.serializeAttachment(peer);
    this.broadcast({ type: 'fix', from: peer.id, iv, ct, serverTs }, ws);
  }

  private setPeerState(ws: WebSocket, peer: PeerState, state: PeerState['state']): void {
    peer.state = state;
    ws.serializeAttachment(peer);
    this.broadcast({ type: 'peer', id: peer.id, state });
  }

  private handleKick(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>): void {
    if (!peer.host) return this.close(ws, 1008, 'only host can kick');
    const targetId = msg.peerId;
    if (typeof targetId !== 'string') return;
    for (const [other, st] of this.peers) {
      if (st.id === targetId) {
        this.send(other, { type: 'ended', reason: 'kicked' });
        this.peers.delete(other);
        other.close(1000, 'kicked');
        this.broadcast({ type: 'peer', id: targetId, state: 'left' });
        this.broadcastPeersCount();
        return;
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    void code; void reason; void wasClean;
    const peer = this.peers.get(ws);
    if (peer) {
      this.peers.delete(ws);
      this.broadcast({ type: 'peer', id: peer.id, state: 'left' });
      this.broadcastPeersCount();
    }
    if (this.peers.size === 0) this.emptySince = Date.now();
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    void error;
    this.peers.delete(ws);
    if (this.peers.size === 0) this.emptySince = Date.now();
  }

  /* ---------------- Alarm：TTL + 心跳 sweep ---------------- */

  async alarm(): Promise<void> {
    const meta = await this.ensureMeta();
    const now = Date.now();

    // TTL 到期 → 關房
    if (meta && now >= meta.expiresAt) return this.endRoom('ttl');

    // 心跳 sweep：>LOST_AFTER_MS 冇訊息 → 標記 lost
    for (const [ws, peer] of this.peers) {
      if (peer.state !== 'lost' && now - peer.lastSeen > LOST_AFTER_MS) {
        peer.state = 'lost';
        ws.serializeAttachment(peer);
        this.broadcast({ type: 'peer', id: peer.id, state: 'lost' });
      }
    }

    // 全部 peer 斷線超過 EMPTY_ROOM_CLOSE_MS → 關房
    if (this.peers.size === 0) {
      if (this.emptySince === null) this.emptySince = now;
      else if (now - this.emptySince > EMPTY_ROOM_CLOSE_MS) return this.endRoom('closed');
    } else {
      this.emptySince = null;
    }

    // 未到 TTL：繼續排下一次 sweep
    if (meta) await this.ctx.storage.setAlarm(Math.min(meta.expiresAt, now + HEARTBEAT_SWEEP_MS));
  }

  /* ---------------- helpers ---------------- */

  private async endRoom(reason: EndReason): Promise<void> {
    this.broadcast({ type: 'ended', reason });
    for (const ws of this.peers.keys()) ws.close(1000, reason);
    this.peers.clear();
    // 清房：storage 只剩空（座標從來冇入過 storage）
    await this.ctx.storage.deleteAll();
    this.meta = null;
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
    catch { /* peer 已斷，忽略 */ }
  }

  private broadcast(msg: ServerMsg, except?: WebSocket): void {
    for (const ws of this.peers.keys()) {
      if (ws === except) continue;
      this.send(ws, msg);
    }
  }

  private broadcastPeersCount(): void {
    this.broadcast({ type: 'peers', count: this.peers.size });
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    this.peers.delete(ws);
    try { ws.close(code, reason); } catch { /* already closing */ }
    if (this.peers.size === 0) this.emptySince = Date.now();
  }
}
