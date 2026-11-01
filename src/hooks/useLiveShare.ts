/**
 * 實時雙向位置分享嘅 React state（PLAN §5.3）。
 *
 * 職責：
 *  - opt-in 之後建房（host）或者由 link fragment 加入（guest）；
 *  - 把自己嘅 fix ~1 Hz 加密送出；收對方密文 → 解密 → peer state；
 *  - TTL 倒數、peer 狀態（連線中 / 已暫停 / 訊號丟失 / 已離開）、一鍵停止、踢走；
 *  - `visibilitychange`：去背景盡力送 `paused`，回前景送 `resume`（§5.3）；
 *  - key 放 `sessionStorage`（reload / iOS 丟棄分頁後還原可以重連），房散即刪（§5.2.1）。
 *
 * 傳輸同加解密喺 `lib/liveShare.ts` / `lib/liveCrypto.ts`，呢度唔碰 WebSocket 細節。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LIVE_API } from '../config';
import type { Fix } from '../lib/geo';
import {
  LiveClient, buildLiveLink, createRoom, parseLiveFragment,
  type EndReason, type LiveStats, type PeerState,
} from '../lib/liveShare';

export type LiveRole = 'host' | 'guest';
/** idle = 未開始；starting = 建房中；connecting = WS 未 open；live = 分享中；ended / error = 已完 */
export type LiveStatus = 'idle' | 'starting' | 'connecting' | 'live' | 'ended' | 'error';

export interface LivePeer {
  id: string;
  state: PeerState;
  /** 最新解密到嘅對方位置；未收到就 null */
  fix: Fix | null;
  /** server 時間（client 用嚟顯示「幾秒前」；device 時鐘唔可靠，§5.2） */
  serverTs: number;
}

/** 同意對話框要講嘅 TTL（同 Worker 預設一致；§5.2） */
export const LIVE_TTL_MINUTES = 30;

const SS_KEY = 'ih-live-session';

interface StoredSession {
  roomId: string;
  key: string;
  hostToken?: string;
  role: LiveRole;
  expiresAt: number;
  /** 打開 link 但未撳同意：reload 後要再問，唔可以自動連線 */
  pending?: boolean;
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (!s.roomId || !s.key || !Number.isFinite(s.expiresAt)) return null;
    if (s.expiresAt <= Date.now()) { sessionStorage.removeItem(SS_KEY); return null; }
    return s;
  } catch { return null; }
}

function writeSession(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem(SS_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SS_KEY);
  } catch { /* private mode 等：冇 sessionStorage 都唔應該阻止分享 */ }
}

export interface LiveShareState {
  /** Worker 未設定（`VITE_LIVE_API` 空）→ UI 隱藏實時分享入口（§5.3 部署前提） */
  available: boolean;
  status: LiveStatus;
  role: LiveRole | null;
  roomId: string | null;
  /** host 先有：join link（key 喺 fragment） */
  link: string | null;
  expiresAt: number | null;
  /** TTL 剩餘毫秒（每秒更新） */
  remainingMs: number;
  peers: LivePeer[];
  peerCount: number;
  /** 中轉延遲統計（?debug=1 面板用；§5.5） */
  stats: LiveStats | null;
  endReason: EndReason | null;
  error: string | null;
  /** 等人同意嘅加入請求（開 link / reload 還原）；null = 冇 */
  pendingJoin: { roomId: string; key: string | null } | null;
  /** 撳「實時分享」→ opt-in 對話框（同意先 call hostStart） */
  hostStart: () => Promise<void>;
  /** 同意加入（pendingJoin） */
  joinAccept: () => Promise<void>;
  /** 拒絕 / 關閉加入提示（清走 fragment） */
  joinDecline: () => void;
  /** 一鍵停止（D8）：關房、所有人斷線 */
  stop: () => void;
  /** 房主踢走某人並令佢條 link 失效（§5.2 防搶位） */
  kick: (peerId: string) => void;
  /** 清走「分享已結束」/ 錯誤提示 */
  dismiss: () => void;
}

/**
 * @param fix 自己嘅最新 fix（live 期間會加密送出）
 */
export function useLiveShare(fix: Fix | null): LiveShareState {
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [role, setRole] = useState<LiveRole | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [peerCount, setPeerCount] = useState(0);
  const [endReason, setEndReason] = useState<EndReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingJoin, setPendingJoin] = useState<{ roomId: string; key: string | null } | null>(null);
  const [stats, setStats] = useState<LiveStats | null>(null);

  const client = useRef<LiveClient | null>(null);
  const lastSentAt = useRef(0);
  const statusRef = useRef<LiveStatus>('idle');
  statusRef.current = status;

  const teardown = useCallback((reason: EndReason | null, errMsg?: string) => {
    client.current?.close();
    client.current = null;
    writeSession(null);
    setPeers([]);
    setPeerCount(0);
    setRoomId(null);
    setLink(null);
    setExpiresAt(null);
    setRemainingMs(0);
    setRole(null);
    setStats(null);
    setEndReason(reason);
    setError(errMsg ?? null);
    setStatus(errMsg ? 'error' : reason ? 'ended' : 'idle');
  }, []);

  /** 建立 client 並連線（host / guest 共用） */
  const connect = useCallback((s: StoredSession, joinLink: string | null) => {
    client.current?.close();
    writeSession(s);
    setRole(s.role);
    setRoomId(s.roomId);
    setLink(joinLink);
    setExpiresAt(s.expiresAt);
    setRemainingMs(Math.max(0, s.expiresAt - Date.now()));
    setPeers([]);
    setPeerCount(0);
    setEndReason(null);
    setError(null);
    setStatus('connecting');

    const c = new LiveClient({
      roomId: s.roomId,
      key: s.key,
      hostToken: s.hostToken,
      apiBase: LIVE_API,
      handlers: {
        onOpen: () => { if (statusRef.current === 'connecting') setStatus('live'); },
        onFix: (from, payload, serverTs) => {
          const f: Fix = {
            lat: payload.lat, lng: payload.lng, accuracy: payload.accuracy, timestamp: serverTs,
          };
          if (payload.speed !== undefined) f.speed = payload.speed;
          if (payload.heading !== undefined) f.heading = payload.heading;
          setPeers(prev => {
            const i = prev.findIndex(p => p.id === from);
            const next: LivePeer = { id: from, state: 'live', fix: f, serverTs };
            if (i < 0) return [...prev, next];
            const copy = prev.slice();
            copy[i] = { ...copy[i], ...next };
            return copy;
          });
        },
        onPeer: (id, state) => {
          setPeers(prev => {
            if (state === 'left') return prev.filter(p => p.id !== id);
            const i = prev.findIndex(p => p.id === id);
            if (i < 0) return [...prev, { id, state, fix: null, serverTs: 0 }];
            const copy = prev.slice();
            copy[i] = { ...copy[i], state };
            return copy;
          });
        },
        onPeerCount: n => setPeerCount(n),
        onStats: s => setStats(s),
        onEnd: reason => teardown(reason),
        onDiscard: () => { /* 解密失敗 / 重放：靜默丟棄（§5.2.1），唔好彈錯誤嚇用戶 */ },
      },
    });
    client.current = c;
    void c.connect();
  }, [teardown]);

  /** 房主：opt-in 同意之後建房 */
  const hostStart = useCallback(async () => {
    if (!LIVE_API) { setError('實時分享未設定'); setStatus('error'); return; }
    setStatus('starting');
    try {
      const room = await createRoom(LIVE_API);
      connect({ roomId: room.roomId, key: room.key, hostToken: room.hostToken, role: 'host', expiresAt: room.expiresAt }, room.link);
      // 網址唔應該留低 roomId / key（access log、Referer；§5.4 第 6 項）
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      teardown(null, '未能建立實時分享，請稍後再試');
    }
  }, [connect, teardown]);

  /** 加入者：同意之後連房 */
  const joinAccept = useCallback(async () => {
    const p = pendingJoin;
    setPendingJoin(null);
    if (!p) return;
    if (!p.key) { teardown(null, '連結唔完整，請叫對方重新傳送'); return; }
    if (!LIVE_API) { teardown(null, '實時分享未設定'); return; }
    // 加入者唔知 server 幾時到期：用本地 TTL 上限做倒數（server 到期會送 ended: ttl）
    const expires = Date.now() + LIVE_TTL_MINUTES * 60000;
    connect({ roomId: p.roomId, key: p.key, role: 'guest', expiresAt: expires }, null);
  }, [connect, pendingJoin, teardown]);

  const joinDecline = useCallback(() => {
    setPendingJoin(null);
    writeSession(null);
    history.replaceState(null, '', location.pathname + location.search);
  }, []);

  /** 開 app：fragment 有 live link 就準備加入；否則 sessionStorage 有未過期 session 就還原 */
  useEffect(() => {
    const frag = parseLiveFragment(location.hash);
    if (frag) {
      // 呢個 build 冇設定 Worker（例如 GitHub Pages 未接 VITE_LIVE_API）→ 唔好彈同意框，直接講明
      if (!LIVE_API) {
        history.replaceState(null, '', location.pathname + location.search);
        setError('呢個版本未接通實時分享，請用官方網址');
        setStatus('error');
        return;
      }
      setPendingJoin({ roomId: frag.roomId, key: frag.key });
      if (frag.key) writeSession({ roomId: frag.roomId, key: frag.key, role: 'guest', expiresAt: Date.now() + LIVE_TTL_MINUTES * 60000, pending: true });
      // 清走 fragment（§5.2.1）：之後 reload 靠 sessionStorage
      history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    const s = readSession();
    // 未同意就 reload：還原成「等同意」，唔好自動連線
    if (s?.pending) { setPendingJoin({ roomId: s.roomId, key: s.key }); return; }
    // 同一個分頁已經同意過（reload / iOS 還原）→ 直接重連，唔使再問
    if (s) connect(s, s.role === 'host' ? buildLiveLink({ roomId: s.roomId, key: s.key }) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 送自己嘅 fix：~1 Hz，但要留返餘量俾心跳 ping —— server 限每 peer 2 條 / s，超咗會斷線（§5.2）
  useEffect(() => {
    if (status !== 'live' || !fix) return;
    const now = Date.now();
    if (now - lastSentAt.current < 1100) return;
    lastSentAt.current = now;
    void client.current?.sendFix({
      lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, speed: fix.speed, heading: fix.heading,
    });
  }, [status, fix]);

  // TTL 倒數（每秒）；本地到期就当結束（server alarm 亦會送 ended: ttl）
  useEffect(() => {
    if (!expiresAt || status === 'ended' || status === 'error') return;
    const tick = () => {
      const left = expiresAt - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) teardown('ttl');
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, status, teardown]);

  // 去背景：盡力送 paused（頁面 suspend 前未必送得出，server 心跳會兜底；§3、§5.2）
  useEffect(() => {
    if (status !== 'live') return;
    const onVisibility = () => {
      client.current?.setPaused(document.visibilityState === 'hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [status]);

  // unmount / 離開頁面：關連線（唔關房，reload 可以重連）
  useEffect(() => () => { client.current?.close(); client.current = null; }, []);

  const stop = useCallback(() => {
    client.current?.stop();
    teardown('stop');
  }, [teardown]);

  const kick = useCallback((peerId: string) => {
    client.current?.kick(peerId);
    setPeers(prev => prev.filter(p => p.id !== peerId));
  }, []);

  const dismiss = useCallback(() => {
    setEndReason(null);
    setError(null);
    setStatus('idle');
  }, []);

  return {
    available: !!LIVE_API,
    status,
    role,
    roomId,
    link,
    expiresAt,
    remainingMs,
    peers,
    peerCount,
    stats,
    endReason,
    error,
    pendingJoin,
    hostStart,
    joinAccept,
    joinDecline,
    stop,
    kick,
    dismiss,
  };
}

