# i-here 改進方案（PLAN）— 修訂版

> 版本：2026-10-31 修訂（同日更新決策：D6 / D7 / D11，見 §12）· 狀態：**已定稿（D6 backlog、D7 E2EE、D11 Pages 保留）** · 代碼基線 commit `ee56cef`（PR #11 merge；之後只有文件變動）
> 本文件記錄 i-here（我在哪裡）下一階段嘅方向、已鎖定嘅決策、同 P2 / P3 / P4 嘅技術方案。
> 修訂依據：實測紀錄（錦上路站 D / A 出口、天水圍）、現有代碼、Cloudflare / 瀏覽器文件。**原稿每一項改動見 §11「修訂紀錄」**；標住「待驗證」嘅係我查唔到確切來源、或者要實機先知嘅說法。

---

## 0. 一句話目標

「一打開就知道自己身處何方，一鍵分享位置」——喺呢個基礎上：
- 令**移動中**（步行 / 車行）嘅定位同地圖體驗都準確流暢；
- 提供**「附近有咩」**清單（受 D2 限制，見 §4.7）；
- 加入**實時雙向位置分享**（雙方都睇到對方實時位置）。

---

## 1. 現況基準（實測 + 代碼）

### 1.1 定位準確度（iPhone，露天，全部係靜止）

| 情景 | 紀錄 | 結果 |
|---|---|---|
| D 出口冷啟動（第 1 次） | 第 1 個 fix ±23.8 m | **實際差約 26 m**；約 17 s 後收窄到 ±3 m |
| D 出口冷啟動（第 2 次，走近出口） | ±16.0 m → 4 s ±10 m → 9 s ±4.3 m → ~25 s ≤±3 m | 最初幾個 fix 實際離最終位置約 **21 m**（回報 ±16 m）；±4.3 m 嗰個只差 **1.9 m** |
| A 出口暖啟動，靜止約 66 s | 第 1 個 fix 已 ±4.1 m，之後 ±2.2–4.1 m | 位置喺約 **4.3 m** 範圍內緩慢漂移（首尾差 2.0 m）；相鄰樣本最多跳 1.8 m |

- **露天靜止定位已達標**（約 9–25 s 後 ≤±4.3 m），但**冷啟動頭幾秒位置可以差 ~20 m**，而且回報精度偏樂觀（±16 m 實際 21 m）。
- `acquireBestFix` 一見到 ≤30 m 嘅 fix 就結束，所以初始顯示位置係**第 1 個 fix**；之後靠 tracking watch 同「精度大幅改善就重查地址」修正。
- **定位融合已試過並移除**（PR #11）：反變差加權假設各 fix 誤差獨立，但實測頭幾個 fix 誤差**同向相關**。重播 D 出口頭 9 個 fix：融合後回報 ±2.9 m、實際差 **8.2 m**；最準單一 fix（±4.3 m）實際只差 **1.9 m**。教訓：**唔好為咗一個靚嘅精度數字而融合相關樣本。** 現時 `acquireBestFix` 輸出最準嘅單一 fix。
- **`proximityFor`**（PR #10）已生效：定位差時「就喺 / 附近」判斷更保守。
- **尚無任何移動中（步行 / 車行）、街道峽谷、室內嘅實測。** P2 嘅目標冇基線，所以 P2 先做 §4.0。

### 1.2 代碼現況

- `Fix` 只保留 `lat / lng / accuracy / timestamp`——丟咗 `coords.speed`、`coords.heading`。
- Tracking：`watchPosition({ enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 })`；位置移動 ≥8 m（或精度明顯變好）先更新。
- 重新查地址規則：移動 ≥40 m 且相隔 ≥15 s；**或**精度改善 >2.5 倍且移動 >10 m（相隔 ≥2 s）。
- `tracking watch` 嘅 error callback 目前**忽略**所有錯誤；`visibilitychange → hidden` 時 `stopTracking()`。
- 地圖：MapLibre（`maxBounds` 鎖喺香港）；「我」標記係 **MapLibre DOM Marker**；deck.gl 只喺設定 `VITE_LANDSD_3DTILES_URL` 時 lazy-load。立體圖建築物用 **OpenFreeMap** 向量圖磚（第三方）。
- `fixLog` 匯出 CSV 只有 `iso_time, lat, lng, accuracy_m, dt_s`——**冇 speed / heading**。
- 分享：靜態快照連結 `?at=lat,lng&n=label`（base 係 `location.href`），對方睇到一個**靜止** pin。

### 1.3 部署現況

- **GitHub Pages**（`.github/workflows/deploy.yml`，push `main` 自動）= 目前對外網址；已流通嘅分享連結全部指向 `iceninye.github.io/i-here/?at=…`。
- **Cloudflare Workers Builds**（dashboard 連咗 repo）：每個 PR 分支出預覽網址（已驗證可用）。根目錄 `wrangler.jsonc` 已有 `assets`（`dist/`、SPA fallback）同 `previews: {}`。
- `ci.yml`（PR 跑 `npm test` + `npm run build`）已存在。

---

## 2. 已鎖定嘅決策（Decision Log）

| # | 決策 | 備註 |
|---|---|---|
| D1 | 用戶 = 任何人（唔止長者+家人） | |
| D2 | **唔起**自建 HK POI / 建築 footprint 資料（無 R2 + PMTiles） | HK 建築識別交給政府 identify API。**後果**：冇「食肆」類（§4.7） |
| D3 | **唔做**離線 / Service Worker | 純線上 PWA |
| D4 | 純 PWA，**唔做** native shell | |
| D5 | 部署 = **Cloudflare Workers**（沿用現有 `wrangler.jsonc` + Workers Builds） | Static Assets + Worker + Durable Objects |
| D6 | 全球方向 A：HK 為主 + OSM 後備，按座標自動切換 | **已決定：降為 backlog（P5）**，P2–P4 不涉及；理由見 §2.1 |
| D7 | **端對端加密（E2EE）**：key 放 link 嘅 `#` fragment，server 只中轉密文 | **已決定**（原稿「明文中轉」取消）；設計見 §5.2.1，理由同限制見 §2.2 |
| D8 | Live share 保留三項基本防濫用：opt-in + 常駐指示 + 一鍵停 / TTL + revoke / 預設唔持久化 | 另加必要嘅工程安全項，見 §5.4 |
| D9 | Live share **預設唔持久化**：DO in-memory（連密文都唔落 storage），房間關閉即冇 | TTL 用 alarm 只存到期時間（無座標），見 §5.2 |
| D10 | 私隱預設：座標只送政府 API；OSM 後備預設關（`VITE_OSM_FALLBACK`） | **已知例外**：立體圖會向 OpenFreeMap 要圖磚；live share 只有**密文**經我哋 server（server 睇唔到座標，但見到 IP、時間、訊息大小） |
| D11 | 對外網址：**GitHub Pages 暫時保留**（唔搬網址、唔轉址） | **已決定**；live share 嘅部署方式（A / B）P4 時定，見 §6.2 |

### 2.1 D6：降為 backlog（已決定）

唔喺 P2–P4 做嘅理由：
1. **冇 work package**：P2 / P3 / P4 都冇列全球化工作（底圖、`maxBounds`、地址來源、語言、`isInHongKong` 判斷）。目前 LandsD 底圖同 `maxBounds` 只覆蓋香港，HK 以外根本睇唔到地圖。
2. **同 D10 衝突**：「HK bbox 外自動行 OSM」等於預設將座標送去第三方 Nominatim，而 D10 話 OSM 預設關。
3. **公共 Nominatim 政策**（二手來源，未讀官方頁面）：整個 app 共用最多 1 request/s、唔准 heavy use、要有識別身份嘅 Referer / User-Agent、要快取；用戶多就要自架或用商業 geocoder。

日後真係要做：先寫 work package（底圖、`maxBounds`、地址來源、語言、`isInHongKong`），並將 D10 改為「HK 以外要用戶按一下同意先用 OSM」。

### 2.2 D7：採用 E2EE（已決定）

原稿「明文中轉」嘅理由係「工程簡化 + 低延遲」，兩樣都唔成立：每秒一條 <200 byte 訊息，WebCrypto AES-GCM 加解密可以忽略；工程量估計約半日（我估算，未實作）。採用 E2EE 嘅理由：
1. 呢個功能最大風險係私隱（被人追蹤）；server 睇唔到座標，私隱聲明可以寫「我哋睇唔到你嘅位置」，而唔係「我哋只係暫存」。
2. **越早做越平**：訊息由第一日就係 `{ iv, ct }`，之後唔使為咗加密而改通訊協議（雙方版本要同步）。

**限制（要老實講）**：
- 保護嘅係 **server 被動接觸**（log、後台人員、資料外洩）。**唔防我哋自己（或被入侵嘅部署）推出惡意 JavaScript**，因為網頁代碼都係我哋 serve。
- Server 仍然見到 IP、連線時間、房間存在同訊息大小。
- 有**完整 link**（連 `#` 後面嘅 key）嘅人都解到密——opt-in 文案仍然要寫明。
- Server 做唔到內容驗證（座標範圍），只可以限制大小同頻率；由收件人解密後驗證。

---

## 3. 貫穿全局嘅硬限制：PWA 無背景定位

**呢條限制同時決定 #2（移動）同 #3（實時分享）嘅體驗上限，必須喺 UI 老實同用戶講。**

- 純 PWA（無 SW、無 native）**冇背景定位**：畫面一去背景（鎖屏 / 切 App），瀏覽器會 suspend `watchPosition`、timer 同 WebSocket。現有 code 已經喺 `visibilitychange → hidden` 時 `stopTracking()`。
- **Screen Wake Lock API** 只可以保持**著屏**（前景），**唔可以**令 App 切背景後繼續定位。
  - iOS：Safari 16.4 起支援，但**加到主畫面嘅 PWA（standalone）要 iOS 18.4 先正常**（二手來源，**待實機驗證**）。
  - 省電模式、低電量可能令申請失敗 → 一定要靜默降級。
- 後果：
  - 高速移動追蹤 → 用戶要**keep 住螢幕著、App 喺前景**。
  - 實時雙向分享 → **雙方**都要 keep 住前景；一方切背景，佢嘅串流即停。
  - **「對方已暫停」唔可以靠對方主動通知**：頁面被 suspend 前通常來唔切送 `paused` / 關 WebSocket。要靠 **server 端心跳逾時**判斷（見 §5.2）。
  - 長時間著屏 + GPS + WebSocket 好食電 → live share 開始前要講明。
- **隧道 / 室內 / 城市峽谷** → GPS 無訊號或多徑，屬物理限制，只能顯示「訊號丟失 X 秒 · 最後已知位置」。

---

## 4. P2｜運動追蹤升級 +「附近有咩」

**性質**：純 client-side，無新 infra，獨立可上線。
**目標**：靜止已準；令步行 / 車行都準同順。

### 4.0 先決：量度基線（新增，P2 第一步）

原稿冇任何移動紀錄就訂門檻同驗收，所以先補：
- 擴充 `fixLog`：`Fix` 記 `speed`、`heading`，CSV 加 `speed_mps, heading_deg` 兩欄（null 留空）。
- 錄**至少 3 段真實紀錄**（可以由乘客錄）：步行（含停低）、乘車（含停站 / 紅燈）、經過隧道或室內。
- 存成測試 fixtures，之後狀態機、插值、訊號丟失全部用 **replay 測試**調參，唔靠估。

### 4.1 `Fix` 保留 speed / heading

- `src/lib/geo.ts`：`Fix` 加 `speed?: number`（m/s）、`heading?: number`（度）；`toFix()` 讀 `coords.speed` / `coords.heading`，`null` / `NaN` 一律當「未知」（唔係 0）。
- 新增**推算速度** `derivedSpeed`：用相鄰兩個 fix 嘅距離 ÷ 時間差；位移細過 `max(accuracy, 5 m)` 當冇郁。`coords.speed` 喺好多情況係 `null`（室內 / Wi-Fi 定位 / 部分 Android），所以一定要有呢個後備。
- 現有測試唔受影響（新欄位 optional）。

### 4.2 運動狀態機

- 新增 `src/lib/motion.ts`：`type MotionState = 'still' | 'walking' | 'fast'`
  - `fast` 取代原稿嘅 `driving`：單車、跑步、小巴都會超過 3 m/s，叫「車行」唔準。
- 速度來源：`speed`（有就用）→ 否則 `derivedSpeed` → 兩者都冇 = **未知，保持上一個狀態**。**`speed == null` 唔等於 still**（原稿呢條會令冇 speed 嘅裝置移動時被當成靜止）。
- 初始建議門檻（**等 §4.0 真實紀錄再調**）：

  | 轉換 | 條件 |
  |---|---|
  | still → walking | 速度 ≥ 0.8 m/s，連續 2 個 sample |
  | walking → still | 速度 < 0.4 m/s，持續 5 s |
  | walking → fast | 速度 ≥ 5.5 m/s（≈20 km/h），連續 3 個 sample |
  | fast → walking | 速度 < 3.5 m/s（≈13 km/h），連續 3 個 sample |

  進出用唔同門檻（hysteresis）避免喺邊界抖動。
- **`maximumAge` / `timeout` 唔係按狀態調嘅有效旋鈕**（原稿 4.2 嘅表要刪）：
  1. `PositionOptions` 喺 `watchPosition()` 建立時固定，要改就要停 watch 再開，會多一輪取得首個 fix 嘅延遲，反而更差。
  2. 原稿話 `maximumAge:10000` 喺 80 km/h 下可能回 220 m 舊 fix——**我哋嘅實測反證**：tracking watch 用緊 `maximumAge:10000`，但 D 出口紀錄每 1.0 s 一個新 fix、時間戳遞增、座標連續變化，冇舊 fix。`maximumAge` 只係令「已有快取位置」可以喺首次回報時直接用（網上搵唔到 `watchPosition` 後續更新嘅確切說明，**待驗證**；但以我哋紀錄為準）。
  3. 保留 `enableHighAccuracy: true`；首次定位仍可用短 `maximumAge`。
- 狀態實際控制嘅係：地名查詢策略、marker 插值、UI（見下表）。

  | 狀態 | 地名查詢 | 地圖 marker | LocationCard |
  |---|---|---|---|
  | still | 現行規則（≥40 m + 15 s，或精度大幅改善時重查） | 靜止，唔插值 | 地名 + 精度 |
  | walking | 同上 | 插值 | 地名 + 精度 |
  | fast | 最多每 200 m / 20 s 一次；只用街名 | 插值 + heading 箭咀 | 街名 + 速度（km/h） |

### 4.3 高速時節流地名查詢（唔係完全暫停）

- `fast` 狀態唔再細緻到「你喺某大廈」，因為高速下大廈名冇意義、又燒 identify / searchNearby。
- 但完全暫停會令乘客睇唔到「而家喺邊條路」；改為**每 200 m / 20 s 查一次，顯示街名**（identify 對街道會回 `addressType: 'ST'`，已實測）。
- 慢返 / 停低（轉做 `walking / still`）先恢復完整地名。

### 4.4 Marker 平滑

- **唔使 deck.gl**：「我」標記係 MapLibre DOM Marker，用 `requestAnimationFrame` + `marker.setLngLat()` 就夠。deck.gl 目前只喺 3D Tiles 時 lazy-load，加入主路徑會令首屏多約 480 kB（gzip，上次含 3D Tiles 嘅 build 實測），違反「保持輕量」。
- 兩個 GPS update（~1 Hz）之間用 `speed` + `heading` 外推，**最多外推 1.5 s**，只喺速度已知、`accuracy ≤ 30 m`、狀態唔係 `still` 時做；新 fix 到達時如果同外推位置差 > accuracy 就直接 snap，唔慢慢拖。
- 訊號丟失時停止外推（§4.6）。
- heading 箭咀需要重新設計「我」標記（而家係帶字嘅 pin），列入 UI 工作。

### 4.5 Screen Wake Lock

- **只喺 opt-in 時申請**（live share 進行中，或用戶打開「保持螢幕著」開關），**唔係**一開追蹤就申請：長時間著屏好食電。
- 回前景時重新申請（失焦時瀏覽器會自動釋放）。
- 唔支援 / 申請失敗 → 靜默降級，只顯示一句「螢幕可能會自動關閉」。iOS 版本限制見 §3。

### 4.6 訊號丟失狀態

- 條件：曾經有 fix，之後 **>10 s**（或 5 倍平均間隔）冇新 fix，而且頁面喺前景。
- UI：「訊號丟失 X 秒 · 最後已知位置」，pin 變灰、精度圈變虛線、停止外推。
- 要改現有 hook：tracking watch 嘅 error callback 而家忽略所有錯誤，要記錄錯誤同時間。

### 4.7「附近有咩」清單

- **重用 `searchNearby`**，唔使自建資料。但要老實講**佢係政府設施資料集，唔係商戶目錄**：錦上路站一帶約 40 項（市區可以有數百至過千項）入面有公廁、郵箱、Wi-Fi 熱點、停車場、回收點、便利店、診所、港鐵出入口、古蹟、賓館，**冇食肆**。
- 所以原稿嘅「食肆」類做唔到（D2 決定唔自建資料）。可達成嘅分組：

  | 類別 | 例子（實測有） |
  |---|---|
  | 交通 | 港鐵出入口 |
  | 便利店 / 超市 | 7-11、惠康 |
  | 診所 / 醫療 | 卓滙醫務中心 |
  | 公廁 | 錦上路公廁 |
  | 郵政 | 錦田郵政局、智郵站 |
  | 景點 / 其他設施 | 鄧伯裘故居、錦田賓館 |

  要加食肆，要引入 OSM / 其他資料，同 D2 / D10 衝突，要另行決定。
- **唔好直接重用 `TITLE_BLACKLIST`**：佢係「唔可以做標題」嘅名單，會連**公廁**一齊過濾；對迷路嘅人，公廁係常用資料。清單另設規則：保留公廁，排除 Wi-Fi 熱點、路旁泊車位、AED、回收點、郵箱。
- 排序同上限：半徑 ≤500 m（API 本身有 1 km），按距離，每組最近 1–2 個，總數 5–8 個；每項顯示距離 + 方向（東南西北）。
- 新增 `pickNearbyList(cands): NearbyItem[]`（同只出 3 個對照地標嘅 `pickLandmarks` 分開）。
- UI：LocationCard 加可展開嘅「附近有咩」。

### 4.8 驗收標準（P2）

- [ ] §4.0 完成：CSV 有 speed / heading；步行、乘車、隧道 / 室內至少各一段真實紀錄存成 fixtures。
- [ ] 狀態機 replay 測試：步行紀錄唔會升去 `fast`；停低 5 s 內回 `still`；`speed == null` 時用推算速度；兩者都未知時保持原狀態。
- [ ] 插值 replay 測試：相鄰幀位移 ≤ 1.2 × 速度 × Δt；新 fix 差 > accuracy 時 snap；訊號丟失即停。
- [ ] 實測一次路面車程（乘客）：marker 唔跳格、`fast` 時地名查詢次數符合節流。
- [ ] 隧道 / 室內顯示「訊號丟失」，保留最後已知位置（變灰）。
- [ ] **靜止唔退步**：冷啟動 ≤±4.3 m 於約 10 s 內；A 出口暖啟動 ±2–4 m（對照 §1.1）。
- [ ]「附近有咩」：用錦上路站 D / A 出口同天水圍 capture 做 fixtures，出到 5–8 項，冇 Wi-Fi / 泊車位 / AED，**公廁保留**。
- [ ] Wake Lock：只喺 opt-in 時申請；唔支援時靜默降級；回前景重新申請。
- [ ] `tsc -b` clean、`vitest` 全綠、`npm run build` 成功。

---

## 5. P3｜實時雙向位置分享

**性質**：最大工程。需要 backend（→ 依賴 P4）。
**目標**：雙方都睇到對方實時位置；**網絡延遲 p95 < 300 ms**（顯示延遲仍然 ≥ GPS 取樣間隔 ~1 s）。
**已鎖定**：端對端加密（D7）+ 防濫用（D8）+ 唔持久化（D9）。

### 5.1 傳輸選型

- **Cloudflare Durable Object + WebSocket**（首選）：一個 session = 一個 DO 房間。
  - **免費計劃只可以用 SQLite-backed DO**：migration 要寫 `new_sqlite_classes`，唔係 `new_classes`（已核實）。
  - 用 **WebSocket Hibernation API**（`ctx.acceptWebSocket()`），房間資料放 `serializeAttachment`，咁 DO 被 evict 後 WebSocket 仍然連住。
  - 建立房間時用 `locationHint: 'apac'`，令 DO 靠近香港（待驗證效果）。
- **免費額度估算**（來源：Cloudflare Durable Objects pricing，2026-10 查閱，以官方頁面為準）：
  - 請求 100,000 / 日；duration 13,000 GB-s / 日；WebSocket incoming 訊息 20 條 = 1 個請求（二手來源）。
  - 一個 30 分鐘、兩人、1 Hz 嘅房：incoming 約 3,600 條 ≈ 180 個請求，**請求額度唔係瓶頸**。
  - duration：1 Hz 訊息令 DO 唔會 idle（唔會 hibernate）；128 MB × 1,800 s ≈ **225 GB-s / 房** → 免費額度約 **57 個半小時房 / 日**（估算，待量度）。自用 / 小規模夠，推廣唔夠。
- 次選：KV / D1 polling——2–5 s 延遲，**唔採用**。

### 5.2 Backend 設計（`LiveShareRoom` Durable Object）

- **API 命名空間用 `/api/`**（唔好用 `/live`，會同 SPA 頁面路徑撞）：
  - `POST /api/live` → 返回 `{ roomId, hostToken }`。`roomId` = 128-bit 隨機（`crypto.getRandomValues`，base64url ≈ 22 字元）。
  - `GET /api/live/ws`（WebSocket upgrade）。**唔好將 `roomId` 放喺 URL**（會入 access log / Referer）；連線後第一條訊息 `hello` 先帶 `roomId`。
- **身份**：建立者持 `hostToken`；加入者只有 `roomId`。原稿由 client 自報 `role: 'host' | 'guest'` 可以被冒充，要刪。
- **防搶位**：link 係 bearer secret，peer 上限 2 時，**最先開 link 嘅人佔位**。對策：
  - 房主即時收到「有人加入」，顯示已加入人數；
  - 房主可以「踢走」並令該 link 失效；
  - 滿員後第三個連線直接拒絕（唔通知對方嘅位置）。
- **訊息驗證**（DO 只中轉，但唔可以盲轉）：單條 ≤512 byte、每個 peer ≤2 條 / s；違規即斷線。**Server 解唔到內容，所以唔驗證座標範圍**——收件人解密後先驗證（`lat ∈ [-90, 90]`、`lng ∈ [-180, 180]`、`accuracy ≥ 0`），唔合法就丟棄。DO 加上 `serverTs`，client 用佢判斷新舊（device 時鐘唔可靠）。
- **狀態由 server 判斷**（唔靠 client 通知）：
  - client 每 5 s 送 `ping`（或有 `fix` 即視為心跳）；
  - 某 peer **>10 s** 冇任何訊息 → server 廣播 `peer: lost / paused`；
  - `paused` / `resume` 訊息保留，但只係**盡力而為**（頁面 suspend 時送唔出）。
- **房間生命週期**：
  - TTL 預設 30 分鐘（可續期）：用 `ctx.storage.setAlarm()` 設到期時間——**storage 只存一個 timestamp，無座標**（D9）。DO 被 evict，alarm 仍會觸發。
  - 任一 peer 送 `stop` → 關房、踢所有人。
  - 所有 peer 斷線 >60 s → 關房。
- **記憶體內只保留**：每個 peer 嘅 **last fix（密文）**（新加入 / 重連時即時補一次，唔使等下一個 1 Hz）。**唔落 storage、唔寫 log。**
- **訊息格式**（JSON；位置喺密文入面，DO 只做大小 / 頻率檢查同廣播）：
  ```ts
  // 控制訊息係明文（冇位置資料）；位置訊息 = AES-GCM 密文，由 client 加解密（§5.2.1）
  type ClientMsg =
    | { type: 'hello'; roomId: string; token?: string }  // token = hostToken（只有建立者）
    | { type: 'fix'; iv: string; ct: string }            // base64url；ct 內含 seq / lat / lng / accuracy / speed / heading / ts
    | { type: 'ping' } | { type: 'paused' } | { type: 'resume' } | { type: 'stop' };
  type ServerMsg =
    | { type: 'peer'; id: string; state: 'joined' | 'live' | 'paused' | 'lost' | 'left' }
    | { type: 'fix'; from: string; iv: string; ct: string; serverTs: number }
    | { type: 'ended'; reason: 'stop' | 'ttl' | 'closed' | 'kicked' };
  ```

### 5.2.1 端對端加密（D7）

- **Key**：建立房間嘅 client 用 `crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])` 產生，匯出成 base64url（43 字元），**只放喺 link 嘅 fragment**：`https://<host>/#live=<roomId>&k=<key>`。Fragment 唔會送去 server，所以 server 同 Cloudflare 都攞唔到 key。
- **加密**：每條位置訊息加密 `{ seq, lat, lng, accuracy, speed?, heading?, ts }`（JSON）。每條用新嘅 96-bit 隨機 IV；`additionalData` = `roomId`（密文綁定個房，搬去另一個房解唔到）。每個房 30 分鐘、約 3,600 條訊息，遠低於同一 key 配隨機 IV 嘅安全上限（約 2^32 條）。
- **重放 / 亂序**：`seq`（每個 sender 遞增）喺密文入面，完整性由 AES-GCM 驗證；收件人丟棄 `seq ≤ 已收最大值` 嘅訊息。
- **Server 見到咩**：`type`、`iv`、`ct` 嘅大小、時間、IP、房間存在。**見唔到**：座標、精度、速度、方向、`seq`。控制訊息（`hello` / `ping` / `paused` / `stop`）係明文，但冇位置資料。
- **Key 嘅生命週期**：
  - 加入者開 link 後，將 `{ roomId, key, 到期時間 }` 放入 **`sessionStorage`**（同一個分頁嘅 reload、或者 iOS 丟棄分頁後還原仍然保留，唔會跨分頁；**待實機驗證**），然後 `history.replaceState` 清走網址嘅 fragment。
  - 唔用 `localStorage`；`stop` / 房間結束 / TTL 到期即刪。
  - 少咗 `k`（例如分享 App 剝走 `#` 後面）→ 顯示「連結唔完整，請叫對方重新傳送」，唔好靜靜地連唔到。
- **WebCrypto** 要 HTTPS（secure context）；iOS Safari 同 Chrome 都支援。
- **測試**：往返加解密；改一個 byte 即驗證失敗；錯 key / 錯 `roomId`（additionalData）解唔到；重放被丟棄；DO 用**亂數密文**照樣中轉、`storage.list()` 冇內容；用 WhatsApp / 短訊實機傳 link 確認 fragment 完整。

### 5.3 Frontend 設計

- **建立流程**：撳「實時分享」→ **opt-in 說明**（§5.4）→ 同意 → `POST /api/live` → 顯示 join link / QR + 倒數 TTL。
- **Join link 放 fragment**：`https://<host>/#live=<roomId>&k=<key>`（key 嘅來源見 §5.2.1）。Fragment 唔會送去 server（唔入 log、唔洩漏落 Referer），亦唔使 SPA 路徑 fallback。
- **加入流程**：開 link → 同樣 opt-in → 連 WS → `hello`。
- **地圖**：己方 marker（藍）+ 對方 marker（另一色，同 §4.4 插值）+ 對方 accuracy 圈。
- **常駐 UI**（必要）：
  - 頂部固定 banner：`［紅點圖示］正在分享實時位置 · 剩 29:12 · ［停止］`（用現有 `Icon` SVG，唔用 emoji）。
  - 對方狀態：`連線中 / 已暫停 / 訊號丟失 / 已離開`，來自 server 嘅 `peer` 訊息。
- **背景處理**：`visibilitychange → hidden` 時盡力送 `paused`；回前景送 `resume` 並檢查 WS，斷咗就重連。
- **重連**：指數退避；房已散 / 過期 → 「分享已結束」。
- **Wake Lock**：live share 期間申請（§4.5）；開始前提示耗電。
- **部署前提**：live share 需要 Worker。GitHub Pages 暫時保留（D11），所以有兩個做法，P4 時定：**B（建議）**Pages 前端跨域呼叫 Worker 嘅 `/api/*`（Worker 加 CORS 同 WebSocket `Origin` 白名單，build 變數 `VITE_LIVE_API` 指向 Worker）；**A** live share 只喺 Cloudflare 網址出現，Pages 版本隱藏入口。見 §6.2。

### 5.4 私隱 / 防濫用

**私隱三項（D8，必做）**
1. **明確 opt-in**：開始前講明「你嘅實時座標會以**加密**方式經 i-here server 中轉（server 睇唔到內容）、TTL X 分鐘、**有完整 link 嘅人都睇到你嘅位置**」；同意先開始。畫面常駐「正在分享實時位置」+ 一鍵停止。
2. **TTL 自動過期 + 可隨時 revoke**：避免一條 link 永久追蹤某人。
3. **預設唔持久化座標**：DO in-memory，房間關閉即冇；唔寫座標 log。

**另加嘅工程安全項（原稿冇）**
4. `POST /api/live` 做 rate limit（每 IP / 每分鐘），房間總數有上限，避免被刷爆 DO。
5. WS 做 `Origin` 檢查；訊息大小同頻率上限（§5.2）。
6. Worker 唔記錄 body；**URL 唔含 `roomId`**（所以用 fragment + `hello`），咁 access log 都唔會有 bearer secret。

**對 D10 嘅例外**：live share 期間，經我哋 server 嘅只有**密文**（加上 IP、時間、訊息大小）；要喺 opt-in 文案、README、私隱聲明寫清楚。
**合規提示**（**唔係法律意見**）：server 只處理密文同連線元數據（IP 亦可能屬個人資料，仍然落入香港《個人資料（私隱）條例》(PDPO) 範圍）。E2EE 加唔持久化，暴露面比明文細好多；仍建議私隱聲明講明「server 睇唔到座標、唔儲存、TTL 後銷毀」。

### 5.5 驗收標準（P3）

- [ ] 兩部機互睇到對方 marker 實時移動；**server 中轉延遲 p95 < 300 ms**（用 `serverTs` 量度；GPS 本身 ~1 Hz 另計）。
- [ ] 一方撳「停止」→ 另一方**即刻**斷線、顯示「分享已結束」。
- [ ] TTL 到期 → 自動關房，雙方收到 `ended: ttl`。
- [ ] 一方切背景或 suspend → 另一方喺 ≤15 s 內顯示「對方已暫停 / 訊號丟失」（server 心跳判斷）；回前景自動恢復。
- [ ] **DO 冇留低座標**：用 `@cloudflare/vitest-pool-workers`（或 miniflare）測試，房間運作後 `storage.list()` 只有 alarm 到期時間，冇座標；Worker log 冇座標。
- [ ] 第三個連線被拒；房主睇到加入人數，可以踢走。
- [ ] 非法 / 過大 / 過頻訊息被拒（單元測試）。
- [ ] opt-in 文案清楚講明加密中轉 + TTL + 「有完整 link 就睇到」。
- [ ] E2EE 測試全部通過：往返、竄改、錯 key / 錯 `roomId`、重放（§5.2.1）。
- [ ] DO 用亂數密文照樣中轉；代碼路徑唔解析 `lat` / `lng`。
- [ ] 實機用 WhatsApp / 短訊傳 link，`#` 後面嘅 key 完整；缺 key 時顯示「連結唔完整」。
- [ ] iOS 分頁被丟棄後還原，仍然可以重連（`sessionStorage`）。
- [ ] `roomId` ≥128-bit；URL 不含 `roomId`。

---

## 6. P4｜Cloudflare Workers 部署 + CI（P3 前置）

**目標**：有 backend + 公網 URL，先做得到 live share。

### 6.1 Wrangler 設定（修改現有 `wrangler.jsonc`，唔係新增 `wrangler.toml`）

原稿寫「`wrangler.toml`（新增）+ `[site]`」有兩個問題：repo 根目錄**已有 `wrangler.jsonc`**（同時有兩份設定檔會混淆）；`[site]` 係已棄用嘅 Workers Sites，現行做法係 **Static Assets**（`assets`），現有設定已經用緊。改為：

```jsonc
{
  "name": "i-here",
  "main": "worker/index.ts",
  "compatibility_date": "2025-09-01",
  "build": { "command": "npm run build" },
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "durable_objects": { "bindings": [{ "name": "LIVE_SHARE", "class_name": "LiveShareRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["LiveShareRoom"] }],
  "previews": {}
}
```

- `run_worker_first: ["/api/*"]`：靜態資產照舊先服務；只有 `/api/*` 先入 Worker。SPA 模式只會對**導航請求**（`Sec-Fetch-Mode: navigate`）回 `index.html`，WebSocket upgrade 唔係導航——但**WebSocket 同 static assets routing 嘅互動我查唔到明確文件，待驗證**（見 §6.3 smoke test）。
- **`previews` 區塊內 DO / migrations 喺 PR 預覽嘅行為待驗證**：預覽可能唔支援 DO，要實測；唔得就 live share 只喺正式環境測。
- `VITE_OSM_FALLBACK` 等 build 變數沿用現有做法。

### 6.2 CI / 部署（原稿「deploy.yml 新增」不正確）

現況：`.github/workflows/deploy.yml` **已存在**（GitHub Pages）；`ci.yml` 已存在；Cloudflare Workers Builds 已連 repo。要決定嘅係：

- **D11（已決定）：GitHub Pages 暫時保留**，唔搬網址、唔轉址；已流通嘅分享連結（`iceninye.github.io/i-here/?at=…`）照舊有效。
  - GitHub Pages **冇 Worker**，所以 live share 要用其中一個方式（P4 時定，建議 B）：
    - **B（建議）**：Pages 前端跨域呼叫 Cloudflare Worker 嘅 `/api/*`。Worker 要加 CORS（處理 `OPTIONS` preflight）同 WebSocket `Origin` 白名單（Pages 網址 + Cloudflare 預覽網址）；build 變數 `VITE_LIVE_API` 指向 Worker。好處：主網址有 live share，唔使搬網址。代價：跨域設定多一層；IP 同密文去 Worker 網域。
    - **A**：live share 只喺 Cloudflare 網址出現，Pages 版本隱藏入口。
  - 分享連結嘅 base 係 `location.href`：兩個網址都可以出連結，各自 serve 同一個 app。
- **用邊個部署 Cloudflare**（二揀一，唔好兩個都做）：
  - **Workers Builds**（而家用緊）：push `main` 自動部署、PR 出預覽，**唔使喺 GitHub 放 API token**，但**冇手動 approval**。
  - **GitHub Actions + `wrangler-action`**：可以加 environment approval，但要放 `CLOUDFLARE_API_TOKEN`；而 environment 審批者功能**私人 repo 要付費計劃**（public repo 免費）。
  - 建議：除非真係要 approval，否則沿用 Workers Builds。
- 先查清楚 `main` 而家喺 Cloudflare 做緊啲咩（production build 嘅 log 我哋仲未見過）。

### 6.3 驗收標準（P4）

- [ ] 公網 URL 同時服務靜態資產同 `/api/*`。
- [ ] Smoke test：`POST /api/live` 開到房；**經 `/api/live/ws` 嘅 WebSocket upgrade 成功**（驗證 static assets routing + WS）；DO migration 生效。
- [ ] SPA 導航（例如重新整理）仍然回 `index.html`。
- [ ] CI 綠；部署方式同 approval 取捨已寫入 README。
- [ ] 選 B：Pages 版本跨域建房 + WebSocket 成功（CORS / `Origin` 通過）；選 A：Pages 版本唔顯示入口。

---

## 7. 排期與依賴

```
P2（client，獨立；先做 §4.0 量度）──► 可單獨上線
                                       │
P4（部署，P3 前置）──────────────────┤
                                       ▼
                                 P3（live share，需 P4；用 P2 嘅 speed / 插值）
P5（全球化，D6）：backlog，未排期
```

**建議順序：P2（§4.0 → …）→ P4 → P3。**
- P2 無 infra 依賴、直接答「移動準唔準」同「附近有咩」；§4.0 嘅量度係之後全部調參嘅基礎。
- P4 係 P3 嘅硬前置。
- P3 工程最大，放最後。

---

## 8. 可行性 / 準確性研究總結

| 功能 | 可行性 | 準確度 / 延遲 | 主要約束 | 私隱 |
|---|---|---|---|---|
| 靜止定位（現況） | ✅ 已有 | 約 9–25 s 後 ≤±4.3 m（實際 1.9 m）；冷啟動頭幾秒可差 ~20 m | — | 座標只送政府 API |
| 步行 / 車行定位 | ✅ P2（**未量度**） | **待 §4.0 量度**（假設戶外 GPS 良好） | **前景先定位**、~1 Hz | 純 client，安全 |
| 「附近有咩」 | ✅ P2（冇食肆） | 跟 `searchNearby`（政府設施資料集） | API 速度；D2 | 座標只送政府 API |
| 實時雙向分享 | ✅ P3（工程大） | 網絡延遲目標 p95 <300 ms；顯示延遲 ≥ GPS ~1 s | **雙方都要著屏前景**；免費額度約 57 個半小時房 / 日（估算） | 端對端加密（D7）+ 防濫用（D8、§5.4） |

**準確性結論**：
- **靜止**：已達標，但要講清楚係「約 9–25 s 後」。
- **戶外移動**：**未量度**，唔係「良好」。呢個係假設，要 §4.0 嘅真實紀錄先確認。
- **隧道 / 室內 / 城市峽谷**：**物理上無解**，只能優雅降級（顯示丟失 + 最後已知位置）。
- **實時分享**：準確度 = 雙方各自 GPS；上限係 PWA 前景限制，唔係演算法。

**研究方向一句話**：真正決定成敗嘅唔係定位演算法（靜止已夠準），而係
1. **PWA 前景限制**（切 App 就停）——用 UI 誠實呈現，同用 server 心跳而唔係 client 通知判斷對方狀態；
2. **移動體驗**（速度推算、狀態機 hysteresis、有界外推、節流地名）——全部要靠真實紀錄 replay 調參，唔係靠估；
3. **live share 嘅私隱 / 防濫用設計**（E2EE、opt-in、TTL、revoke、唔持久化、防搶位、rate limit）。

---

## 9. 風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| PWA 無背景定位 | 移動 / 分享一鎖屏就停 | Wake Lock（opt-in）+ UI 明示限制 + server 心跳判斷「對方已暫停」 |
| Key 洩漏 = link 洩漏（D7 E2EE） | 有完整 link 嘅人都睇到位置 | opt-in 文案講明；TTL；房主可踢 / 停；key 喺 fragment 唔送 server，加入後清走網址 |
| 分享 App 剝走 `#` fragment | 加入者冇 key，連唔到 | 顯示「連結唔完整」；實機用 WhatsApp / 短訊測；失敗再考慮 QR / 手動輸入 |
| iOS 丟棄分頁令 key 遺失 | 回前景要重新攞 link | key 放 `sessionStorage`（待實機驗證） |
| E2EE 唔防惡意 JS | 被入侵嘅部署可以偷 key | 部署帳戶開 2FA、最小權限；README 講明限制 |
| Link 被別人先開（搶位） | 非預期嘅人睇到位置 | 房主見加入人數、可踢、滿員拒絕、`roomId` 128-bit |
| DO 免費額度 | 約 57 個半小時房 / 日（估算） | TTL 短、房間關閉即釋放；監控；必要時升 paid |
| 刷 `POST /api/live` | DO 被刷爆 | rate limit + 房間總數上限 |
| WebSocket 同 static assets routing 互動未驗證 | 部署後 live share 連唔到 | P4 smoke test 必須覆蓋 WS upgrade |
| `previews` 內 DO 支援未知 | PR 預覽測唔到 live share | 實測；唔得就正式環境測 |
| 公共 Nominatim 政策（D6） | 多用戶被封 | D6 降為 backlog；自架 / 商業 geocoder |
| Pages 同 Workers 兩個網址（D11） | CORS / `Origin` 設定出錯、功能分叉 | 選 B 時 smoke test 覆蓋跨域；選 A 時隱藏入口 |
| iOS 主畫面 PWA Wake Lock（<18.4 不可靠） | 著屏失效 | 實機驗證；降級提示 |
| searchNearby 回大量項 | client 處理 / API rate | client filter + rank；節流；只喺需要時查 |
| 隧道無訊號 | 定位中斷 | 優雅降級 + 最後已知位置 |
| 冇移動基線就調參 | 門檻拍腦袋 | §4.0 先量度、replay 測試 |

---

## 10. 附錄：涉及檔案（預計）

**P2**
- `src/lib/geo.ts`（`Fix` 加 speed / heading、`derivedSpeed`）
- `src/lib/fixLog.ts`（CSV 加 speed / heading 欄）
- `src/lib/motion.ts`（新增，狀態機）
- `src/hooks/useCurrentLocation.ts`（狀態、節流地名、訊號丟失、Wake Lock opt-in；tracking error callback）
- `src/lib/reverseGeocode.ts`（`pickNearbyList`、分類擴充）
- `src/components/MapView.tsx`（rAF 插值；heading 箭咀）、`LocationCard.tsx`（速度、附近有咩）

**P4**
- `wrangler.jsonc`（**修改**，唔係新增 toml）
- `worker/`（新增：Worker 入口 + DO 類別）
- `.github/workflows/`：`deploy.yml`（GitHub Pages，已存在）、`ci.yml`（已存在）；只有選 Actions 部署 Cloudflare 先另加 `deploy-cloudflare.yml`

**P3**
- `worker/liveShareRoom.ts`（DO）
- `src/lib/liveCrypto.ts` + `liveCrypto.test.ts`（E2EE：產生 key、加解密、`seq`）
- `src/lib/liveShare.ts`（WS client + 協議）、`src/hooks/useLiveShare.ts`
- `src/components/LiveShareBanner.tsx` + opt-in dialog
- `src/components/MapView.tsx`（對方 marker）

---

## 11. 修訂紀錄（相對原稿）

| # | 位置 | 原稿 | 問題 | 依據 | 修正 |
|---|---|---|---|---|---|
| 1 | §1 | 「最準單一 fix ±4.3 m，實際誤差 1.9–8.2 m」 | 將最準單一 fix（1.9 m）同融合結果（8.2 m）混成一個範圍；冷啟動頭幾個 fix 差 ~21 m 冇交代 | D 出口兩次冷啟動、A 出口紀錄 | §1.1 逐情景列數字 |
| 2 | §1 | Tracking「reverse geocode 節流 15 s / 40 m」 | 漏咗「精度改善就重查」 | `useCurrentLocation.ts` | §1.2 更新 |
| 3 | §1 | （冇提）無移動基線；`fixLog` 冇 speed / heading | P2 冇基線就訂門檻同驗收 | `fixLog.ts` | 新增 §4.0 |
| 4 | §1 | （冇提）部署現況 | 已有 GH Pages + Workers Builds + `wrangler.jsonc` | repo | 新增 §1.3 |
| 5 | D5 / §6.1 | `wrangler.toml（新增）`、`[site]`；migrations 冇寫類型 | 已有 `wrangler.jsonc`；`[site]` 係已棄用嘅 Workers Sites；免費計劃只可以用 SQLite DO | repo；Cloudflare 文件 | 改現有 jsonc；用 `assets`；`new_sqlite_classes` |
| 6 | §6.2 | 「`deploy.yml`（新增）」 | 已存在（GitHub Pages）；Workers Builds 已部署預覽；兩個都做會重複 | repo | 二揀一；講明 approval 取捨 |
| 7 | D6 | 「全球方向 A，自動切換」 | 冇 work package；同 D10 衝突；公共 Nominatim 政策；`maxBounds` / LandsD 底圖只覆蓋香港 | `MapView.tsx`；Nominatim 政策（二手） | §2.1，建議降為 backlog |
| 8 | D7 | 「換取工程簡化 + 低延遲」 | E2EE 唔會明顯加延遲 | 常識 / WebCrypto | §2.2 修正理由，決定交返用戶 |
| 9 | D9 | 「DO 只 in-memory」 | TTL 要 alarm，alarm 會寫 storage | Cloudflare DO 文件 | 講明只存到期時間，無座標 |
| 10 | §4.2 | 「`speed == null` → `still`」 | `null` 係「未知」，唔係靜止；冇 speed 嘅裝置移動時會被誤判 | Geolocation API 行為 | 推算速度；未知保持原狀態 |
| 11 | §4.2 | 按狀態調 `maximumAge` / `timeout`；「80 km/h 可回 220 m 舊 fix」 | 選項喺 watch 建立時固定；實測 `maximumAge:10000` 下仍然每 1.0 s 新 fix | D 出口 CSV；W3C 規格 | 刪表；改為控制地名 / 插值 / UI；標明 `watchPosition` 語義待驗證 |
| 12 | §4.2 | 狀態 `driving`，>3 m/s | 單車、跑步都 >3 m/s；邊界會抖動 | — | 改 `fast`；hysteresis；門檻待真實紀錄調 |
| 13 | §4.3 | 高速時完全暫停地名 | 乘客睇唔到而家喺邊條路 | identify 對街道回 `ST`（實測） | 節流（200 m / 20 s）顯示街名 |
| 14 | §4.4 | 「Marker 平滑（deck.gl）」 | 「我」標記係 MapLibre DOM Marker；deck.gl 只喺 3D Tiles lazy-load，加入主路徑 +~480 kB gzip | `MapView.tsx`；build 輸出 | rAF + `setLngLat`；外推 ≤1.5 s |
| 15 | §4.5 | 追蹤期間就申請 Wake Lock | 長時間著屏好食電；iOS 主畫面 PWA 要 ≥18.4 | MDN / WebKit 二手來源 | 只喺 opt-in 時申請；待實機驗證 |
| 16 | §4.7 | 分組含「食肆」；重用 `TITLE_BLACKLIST` | `searchNearby` 係政府設施資料集，約 40 項冇食肆；`TITLE_BLACKLIST` 會濾走公廁 | exit D capture | 重寫分組；清單另設規則；食肆列為 D2 後果 |
| 17 | §5.2 | client 自報 `role`；peer 上限 2；靠 client 送 `paused` | `role` 可冒充；link 係 bearer，先開者佔位；頁面 suspend 時送唔出 `paused` | — | `hostToken`；加入人數 / 踢走；server 心跳；訊息驗證 + `serverTs` |
| 18 | §5.3 | join link 用 `/live/<id>`；banner 用 🔴 | 路徑入 log / Referer；PR #10 已用 SVG 圖示取代 emoji；`/live` 同 SPA 路徑撞 | repo | fragment + `hello`；`/api/` 命名空間；用 `Icon` |
| 19 | §5.1 / §9 | 「DO 喺 free tier 已可用」 | 只限 SQLite DO；免費額度有限 | Cloudflare pricing | 加限額同估算（約 57 個半小時房 / 日，待量度） |
| 20 | §8 | 移動「✅ 戶外良好」「延遲 <1 s」 | 冇移動實測；<1 s 冇定義（GPS 本身 ~1 Hz） | — | 標「未量度」；改成網絡延遲 p95 <300 ms |
| 21 | §4.8 / §5.5 | 「靜止唔退步（1.9–8.2 m）」「marker 唔跳格」「maximumAge=0 生效」 | 基線錯；主觀；前提錯 | §1.1 | 改成可測驗收（replay 測試、對照 §1.1） |
| 22 | 全文 | 簡體字、錯字（验收标准、优雅、静默、認証、房散） | 用字不統一 | — | 統一繁體 |
| 23 | §7 | P2 → P4 → P3 | 缺 §4.0；D6 冇位置 | — | 加 §4.0；加 P5 backlog |

**冇改嘅（原稿正確）**：D1–D4、D8（私隱三項）、D10 主體、DO + WebSocket 作首選、PWA 無背景定位嘅硬限制、P2 → P4 → P3 順序、`Fix` 欄位描述、融合已移除嘅結論、commit `ee56cef`。

---

## 12. 決策更新（2026-10-31，修訂版定稿後）

| # | 決定 | 方案改動 |
|---|---|---|
| D6 | **降為 backlog（P5）** | §2.1 改為「已決定」；風險表保留 Nominatim 一項 |
| D7 | **採用 E2EE**（取消原稿「明文中轉」）；§11 第 8 項嘅「決定交返用戶」已有答案 | §2.2 重寫；新增 §5.2.1（key 放 fragment、AES-GCM、`roomId` 做 additionalData、`seq` 防重放、`sessionStorage`）；§5.2 訊息改為 `{ iv, ct }`；§5.4 opt-in 文案、PDPO 提示、§5.5 驗收、§9 風險、§10 檔案 |
| D11 | **GitHub Pages 暫時保留**，唔搬網址 | §6.2 改為已決定；live share 嘅 A / B 做法 P4 時定（建議 B：Pages 跨域呼叫 Worker）；§5.3、§6.3、§9 同步 |

**仍然待確認**：D11 嘅 A / B（P4 時，需要 CORS / `Origin` smoke test）；`sessionStorage` 喺 iOS 分頁還原後嘅行為（實機）；`#` fragment 經 WhatsApp / 短訊是否完整（實機）。
**未開始**：P2 / P4 / P3 全部未動工，等你話事。
