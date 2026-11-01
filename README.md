# 📍 我在哪裡 · i-here

**一打開就知道自己身處何方，一鍵分享位置。**

好多時喺街上會唔知自己喺邊（長者、遊客、迷路嘅人都一樣）。i-here 打開即定位，用**大字**顯示「你現在位於：興輝樓附近」同官方門牌地址，再撳一個**大綠色掣**就可以用 WhatsApp / 短訊 / Telegram 將精準位置傳俾朋友或家人。大字、高對比、少術語係預設，任何人都適用。

數據來自香港地政總署（LandsD）同 OGCIO 開放數據；定位技術沿用並改良自 [mtr-app](https://github.com/iceninye/mtr-app)。

---

## 1. 技術架構：點解揀 MapLibre GL JS

| | MapLibre GL JS ✅ | Mapbox GL JS | CesiumJS |
|---|---|---|---|
| 首屏 JS（gzip） | ~285 KB | ~300 KB + 需 token | ~1 MB+ |
| 地政總署 XYZ / 向量瓦片 | 原生支援 | 支援，但要 Mapbox 帳戶 | 支援，但 2D 體驗一般 |
| 3D 建築物 | `fill-extrusion`（輕量）＋ deck.gl `Tile3DLayer`（3D Tiles） | 同左 | 原生 3D Tiles 最強 |
| 手機效能 / 電量 | 好 | 好 | 較重，舊手機會熱 |
| 授權 | BSD，免費 | 專有，按用量收費 | Apache 2.0 |

**結論**：呢個 App 嘅首要任務係「快、清楚」，3D 只係輔助認路。所以：

- **2D（預設）**：MapLibre + 地政總署 XYZ 底圖 + 中文標籤瓦片。
- **3D「立體圖」（撳先載）**：
  1. 輕量模式（預設）：傾斜 60° + `fill-extrusion` 建築物外廓，並將**你身處嗰幢染橙色**，方便對照現實。
  2. 地政總署 3D 視覺化地圖（Tile-based models）：設定 `VITE_LANDSD_3DTILES_URL` 後，用 deck.gl `Tile3DLayer` 疊加。deck.gl 係 **lazy import**，冇設定 URL 時連 bundle 都唔會包（build 時 tree-shake 走）。
- 唔揀 CesiumJS：要做到同樣嘅 2D 清晰度，首屏要多載 ~1 MB，對慌亂中嘅長者、弱網絡係錯誤取捨。

## 2. 定位 → 地址流程（`src/hooks/useCurrentLocation.ts`）

```
GPS (WGS84)
  │ ① 取樣窗：watchPosition 8 秒內收集多個 fix，保留最準；≤30 m 即刻停（移植自 mtr-app）
  │    每個更準嘅 fix 即時更新地圖（唔使等成個取樣窗）
  ▼
HK80：本機 proj4（EPSG:2326）即刻計；地政總署坐標轉換 API（www.geodetic.gov.hk，~0.3 s，回 `{ hkN, hkE }`）喺背景核對，唔阻住查地址
  │   （實測 3 個位置：本機同官方只差約 1 mm；舊網址 geodetic.landsd.gov.hk 永遠冇回應）
  ▼
identify（www.map.gov.hk，~0.2–1.4 s）→ 你所在嘅大廈 / 屋苑 / 車站，或者街道（街道冇座標，當作就喺查詢點；路口會有幾條）；一回就顯示
searchNearby（同一 host）→ 1 km 內設施。回應冇距離上限，而且大部分係 WiFi 熱點、郵箱、路旁泊車位、
                           停車場、AED，所以只用嚟做「附近還有」，並經黑名單 + 分類 + 距離篩選
  ▼   標題分數 = 距離 + 類別罰分（大廈 / 屋苑 0 < 車站 20 < 店舖 40 < 設施 60 < 街道 130）
  ▼
ALS 門牌地址搜尋（用地名查；街名唔查，因為 ALS 對「天福路」會回沙田嘅結果）→ 只收離「呢個地方自己座標」60 m 內嘅（柏瓏：4 m；A 出口嘅第一個結果係 165 m 外嘅另一幢大廈，要拒絕）→ 補官方中文地址（地名已經先顯示咗）
  ▼
「你現在位於：興輝樓附近」＋ 地址 ＋ 附近還有：大興街市（95 米）…
```

之後保持低頻追蹤：**行開 40 m 以上**先再查地址（最少相隔 15 秒）；App 去咗背景就停 GPS 慳電。

### 相對 mtr-app 嘅改良

| mtr-app | i-here |
|---|---|
| 精度 > 1000 m 直接拒絕 | **照樣顯示**，加警告「請走到空曠地方」—— 迷路時大概位置好過冇位置 |
| 取樣完先處理 | 取樣期間逐步更新地圖 |
| 範圍檢查 20–24°N / 113–115°E | 收窄到香港範圍 |
| 一次性定位 | 低頻追蹤 + 背景暫停 |

## 3. 一鍵分享（`src/components/ShareButton.tsx`）

- 有 **Web Share API**（iOS Safari、Android Chrome）→ 直接彈原生分享選單。
- 冇 / 失敗 → 大按鈕後備選單：**WhatsApp**（`wa.me`）、**短訊**（`sms:?&body=`，iOS / Android 通用）、**複製文字**。
- **未查到地址都可以分享座標**，緊急時唔會因為 API 失敗而分享唔到。
- 訊息格式（第一行就係重點，通知預覽都睇到）：

```
📍 我而家喺：興輝樓附近
地址：新界屯門區大興邨興輝樓
附近：大興街市、大興體育館
時間：17:29（誤差約 18 米）

Google 地圖：https://www.google.com/maps/search/?api=1&query=22.408010,113.973120
地圖（i-here）：https://iceninye.github.io/i-here/?at=22.408010,113.973120&n=興輝樓附近
```

收件人撳 i-here 連結會見到地政總署地圖上嘅紅色「對方」標記，同一個「用 Google 地圖導航前往」掣；**唔會即刻彈定位權限**，要自己撳「看看我自己的位置」先定位。

## 4. UI / UX：慌亂中都一眼睇得明

- **一個畫面、一個主要動作**：上面係位置卡，中間係地圖，下面係成個闊度、80 px 高嘅綠色「分享我的位置」。
- **大字**：地名 28–38 px 粗體，地址 20 px；全部用 `rem`，跟手機「字體大小」設定放大。
- **用說話，唔用術語**：「很準確（約 18 米內）」而唔係「±18 m」；冇「HK80」「座標」呢啲字眼。
- **標記有字**：藍色「我」、橙色「對方」（實時分享）、紅色「對方」（靜態分享連結），唔使識睇藍點。
- **移動中先至平滑**：「我」同對方嘅 marker 用 rAF + speed / heading 外推（≤1.5 s），行路車路唔會一格一格跳；方位角已知時 marker 有箭咀指住行緊嘅方向（未知就唔顯示 —— 未知 ≠ 向北）。靜止時完全唔外推，避免 GPS 抖動令個點游移。
- **訊號丟失講得出**：>10 s 冇新 fix 就顯示「訊號丟失 · 最後已知位置」，pin 變灰、精度圈變虛線、停止外推（隧道 / 室內唔會假裝仲追到）。
- **高速時顯示街名而唔係大廈名**：`fast` 狀態下地名查詢節流放寬到 200 m / 20 s，並優先揀街道（`addressType: 'ST'`），乘客都知自己喺邊條路。
- **「附近有咩」**：位置卡底部可展開清單（交通、便利店、診所、公廁、郵政、景點），每項有距離同方向；政府資料集冇食肆（見 PLAN §4.7 / D2）。
- **螢幕保持亮著要 opt-in**：實時分享期間自動申請 Screen Wake Lock，或者自己撳「保持螢幕著」；唔支援嘅裝置靜默降級，只提一句「螢幕可能會自動關閉」（PWA 冇背景定位，熄屏就冇 GPS）。
- **防誤觸**：停用地圖旋轉；拖動地圖後出現「回到我的位置」，唔會自己飛走。
- **出錯都有路行**：權限被拒時直接教 iPhone / Android 點開；冇地址時講明「仍然可以分享」。
- **無障礙**：只有一行隱藏嘅 `role=status` 會被讀屏器讀出（唔會成張卡反覆讀）；按鈕有文字（emoji 設 `aria-hidden`）；焦點框 4 px 黃色；`prefers-reduced-motion` 停動畫；觸控目標 ≥ 56 px。

## 5. CORS 與部署注意事項

### 跨域（CORS）

實測（手機）：`www.map.gov.hk`（identify / searchNearby）同 ALS 都回 `Access-Control-Allow-Origin: *`，**毋須 CORS 代理**。
`geodata.gov.hk/gs/api/*` 嘅請求一直冇回應，已經唔再使用。坐標轉換 API 有時好慢，所以只喺背景核對。

**最佳做法**：

1. **每個 API 都有 timeout、`AbortController` 同後備**：政府 API 全部失敗，都只係顯示座標，仍然可以分享位置。
2. **預設唔將座標送去第三方**（OpenStreetMap 後備要 build 時設 `VITE_OSM_FALLBACK=1` 先開）。
3. **HTTPS 必須**：Geolocation 同 Web Share API 只喺 HTTPS / `localhost` 用得。
4. **Rate limit**：只喺移動 > 40 m 先重新查地址。
5. **唔加 Service Worker**：避免 cache 舊地址 / 舊位置。
6. **Base path**：`vite.config.ts` 用 `base: './'`，同一份 build 放 GitHub Pages（`/i-here/`）或根目錄都得。

### 部署

- **GitHub Pages**：push 去 `main` 自動 build + 部署（`.github/workflows/deploy.yml`）。第一次要喺 repo **Settings → Pages → Source** 揀 **GitHub Actions**。
- **Cloudflare Workers**：根目錄 `wrangler.jsonc` 已經唔係純靜態部署 —— `main: worker/index.ts` 提供 `/api/*`（實時分享），其餘路徑由 `assets`（`dist/`）服務，`run_worker_first: ["/api/*"]` 令 API 先入 Worker。部署：`npx wrangler deploy`（或 Workers Builds，build command `npm run build`）。
- 可選 Actions variables：`VITE_OSM_FALLBACK`、`VITE_LANDSD_3DTILES_URL`、`VITE_LIVE_API`（見 `.env.example`）。
- PR 會自動跑測試同 build（`.github/workflows/ci.yml`）。

## 6. 實時雙向位置分享（`worker/` + `src/lib/liveShare.ts`）

兩個人互相睇到對方實時位置（§5，PLAN）。**核心限制**：PWA 冇背景定位，雙方都要保持畫面開著前景。

```
瀏覽器 A ──WebSocket──► Cloudflare Worker（/api/live/ws）──► Durable Object「LiveShareRoom」──► 瀏覽器 B
                          只中轉密文，永遠解唔到座標
```

- **建房**：`POST /api/live` → `{ roomId, hostToken, expiresAt }`（TTL 預設 30 分鐘，用 DO alarm 到期關房）。
- **加入**：link 係 `https://<host>/#live=<roomId>&k=<key>`。**roomId 同 AES key 只喺 fragment**，唔會送去 server（唔入 access log、唔洩漏落 Referer）；WebSocket 嘅 roomId 經 `Sec-WebSocket-Protocol` 傳（URL 完全冇 roomId），DO 要喺 upgrade 時揀 stub，所以唔可以等連線後嘅 `hello`。
- **E2EE**（`src/lib/liveCrypto.ts`）：AES-GCM 256，key 由建房嗰部機產生並只放喺 fragment；每條訊息新 96-bit IV，`additionalData = roomId`（搬去另一個房解唔到）；`seq` 做重放保護。Server 見到嘅只有 `type`、`iv`、`ct` 大細、時間、IP。
- **唔持久化**：DO 記憶體只保留每個 peer 嘅最後一條**密文**（新加入 / 重連即刻補發），storage 只有 `{ roomId, hostToken, expiresAt }`，冇任何座標。房散即冇。
- **防濫用**：明確 opt-in 說明 + 畫面常駐「正在分享實時位置」+ 一鍵停止；peer 上限 2（第三個連線直接拒絕）；房主可以踢走；單條 ≤512 byte、每 peer ≤2 條 / s；`POST /api/live` 每 IP 每分鐘限速；WS 做 `Origin` 檢查。
- **狀態由 server 判斷**：client 每 5 s ping（有 fix 亦算心跳），>10 s 冇訊息就廣播「訊號丟失」；頁面去背景盡力送 `paused`（suspend 前未必送得出，所以有心跳兜底）。
- **對方 marker**：橙色，用自己嘅 speed / heading 做同「我」一樣嘅外推插值（≤1.5 s）。
- **設定**：build 時設 `VITE_LIVE_API=https://i-here.<user>.workers.dev`；留空就完全隱藏入口（GitHub Pages 未接 Worker 時唔會出現半個功能）。
- **量延遲**：網址加 `?debug=1`，診斷面板嘅 `live:` 行有 RTT 同中轉延遲（ping / pong 做 NTP 式鐘差估算，目標 p95 < 300 ms）。
- **測試**：`npm run test:worker`（跑喺 workerd，`@cloudflare/vitest-plugin`）驗證 subprotocol 路由、密文原封中轉、storage 冇座標、滿員拒絕、TTL alarm。

## 🛠️ 本機開發

```bash
npm install
npm run dev        # http://localhost:5173（定位要 localhost 或 HTTPS）
npm test           # 前端單元測試（定位取樣、HK80、地址解析、E2EE、分享文字）
npm run test:worker # Worker / Durable Object 測試（跑喺 workerd）
npm run typecheck  # 前端 + worker 兩套 tsconfig
npm run build
```

想試實時分享：`npx wrangler dev`（Worker + DO 本機跑），然後 `.env.local` 設 `VITE_LIVE_API=http://localhost:8787` 再起 `npm run dev`。

手機實測：`npm run dev -- --host`，再用 `ngrok` / Cloudflare Tunnel 開 HTTPS。

## 🗂️ 檔案結構

```
src/
  hooks/useCurrentLocation.ts   定位 → HK80 → 地標 / 地址（核心 hook）
  hooks/useLiveShare.ts         實時分享 state：建房 / 加入、1 Hz 送 fix、peer 狀態、TTL、停止
  hooks/useWakeLock.ts          Screen Wake Lock（分享期間保持螢幕亮著；唔支援就靜默降級）
  lib/geo.ts                    取樣窗定位、範圍檢查、距離（移植自 mtr-app）
  lib/motion.ts                 運動狀態機（still / walking / fast，有 hysteresis）
  lib/interpolate.ts            marker 外推插值（≤1.5 s，speed + heading）
  lib/hk80.ts                   坐標轉換 API + proj4 後備
  lib/reverseGeocode.ts         identify API + ALS 地址補全 +「附近有咩」
  lib/shareText.ts              分享訊息、WhatsApp / SMS / 收件人連結
  lib/liveCrypto.ts             AES-GCM E2EE：key 匯出入、加解密、重放保護
  lib/liveShare.ts              join link fragment、建房、WebSocket client（subprotocol 帶 roomId）
  components/ShareButton.tsx    Web Share API + 後備選單
  components/LocationCard.tsx   大字位置卡（速度、訊號丟失、附近有咩）
  components/MapView.tsx        MapLibre 地圖、精度圈、插值、2D / 3D、對方 marker
  components/LiveShareBanner.tsx   常駐「正在分享實時位置 · 剩 mm:ss · 停止」
  components/LiveShareConsent.tsx  opt-in 私隱說明（同意先開始）
  components/landsd3dTiles.ts   地政總署 3D Tiles（lazy）
worker/
  index.ts                      /api/live（建房）、/api/live/ws（upgrade → DO）、CORS、靜態資產
  liveShareRoom.ts              Durable Object：房間、心跳、TTL alarm、密文中轉
  http.ts                       Origin 白名單、CORS、每 IP rate limit
wrangler.jsonc                  Worker + assets + Durable Object（SQLite class）設定
wrangler.test.jsonc             測試專用設定（vitest workerd）
```

## 📏 定位實測（iPhone，錦上路站 D 出口，靜止約 75 秒）

- 第一個 fix：±23.8 m，**真實誤差約 26 m**（同畫面上嘅「±24 米」吻合，所以 ±15 m 以上唔再叫「很準確」）。
- 約 17 秒後收窄到 ±3 m；之後靜止時抖動只有約 1–2 m（±2–5 m）。
- 所以：**露天靜止時唔需要自己平均 / 平滑**，OS 融合已經夠好；關鍵係**精度變好之後要重新查地址**（以前要行夠 40 m 先重查，會一直停喺粗略位置嘅結果，標題變咗 79 m 外嘅屋苑）。
- 錦上路站 A 出口（靜止約 66 秒）：第一個 fix 已經 ±4.1 m（OS 有暖機位置），之後 ±2.2–4.1 m；位置慢慢漂移約 2 m，抖動 < 1 m。同一部機喺 D 出口冷啟動（第一個 fix 差 26 m）對比，可見**差別在冷啟動**，唔在平滑。
- 錦上路站 D 出口第二次（冷啟動，走近出口）：16.0 m → 10 m（4 s）→ 4.3 m（9 s）→ ≤3 m（約 25 s）；最初幾個 fix 實際離最終位置約 21 m（回報 ±16 m），所以仍然要「精度改善就重查」。
- **試過「反變差加權融合」但已拎走**：用 D 出口冷啟動頭 9 個 fix 重播，融合後回報 ±2.9 m、實際差 8.2 m；最準單一 fix（±4.3 m）實際只差 1.9 m。原因：早期 fix 誤差同向（相關），八個中等 fix 嘅合共權重壓過一個好 fix，而且融合精度 1/√Σw 會細過任何單一 fix（過度自信）。喺三次實測紀錄上，第 1 個 fix 已 ≤30 m，取樣即刻結束，融合根本冇作用。現在輸出最準嗰個單一 fix（`src/lib/geo.test.ts` 用真實紀錄鎖住呢個行為）。
- 未量度：街道峽谷（旺角）、室內、行路中。

## ⚠️ 已知限制 / 待驗證

- `identify` 嘅回應格式已用真實手機回應確認（`src/lib/__fixtures__/identify-*.json`：錦上路站、天水圍站、柏瓏、A 出口……部分節錄，天福路、宏達路完整）。`addressType`：ST 街道、S 屋苑、P 平台、B 建築物、F 設施。
- `ALS` 嘅輸出語言由 `Accept-Language` 決定：以前冇傳，只回英文；傳 `en,zh-Hant` 之後每個結果都有 `ChiPremisesAddress`（`ChiDistrict.DcDistrict`、`ChiStreet.StreetName / BuildingNoFrom`、`ChiEstate.EstateName`、`ChiBlock.BlockDescriptor / BlockNo`、`BuildingName`），已用真實回應確認（`als-kam-sheung-road-d-access.json`，完整）。ALS 嘅文字配對可以配到另一個地方（D 出口 → 300 m 外嘅「港鐵錦田大樓」），所以只收離地方本身 60 m 內嘅。
- 坐標轉換 API 已用真實回應確認（`transform-kam-sheung-road-a.json`）。
- `searchNearby` 真實格式已確認（`searchnearby-kam-sheung-road-exit-d.json`，43 項中揀 16 項原文）：`[{ name, address, x, y, additionalInfoKey[], additionalInfoValue[] }]`。
- **診斷方法**：網址加 `?debug=1`，位置卡下面會出「診斷資料」（第一行 `build:` 係版本，手機有時會跑緊舊快取，貼紀錄時請連埋呢行）：每個 API 嘅狀態、耗時（等緊嘅都睇到）、原始回應，同埋原始定位紀錄 CSV（用嚟量度誤差）。
- 輕量 3D 建築物用 OpenStreetMap 高度數據（OpenFreeMap 向量瓦片）：開立體圖時會向 OpenFreeMap 要圖磚，等於將畫面範圍告訴佢；之後會改用自己託管嘅資料。
- 北區同深圳交界一帶，經緯度範圍檢查無可避免會重疊；嗰度 identify 搵唔到大廈就只顯示座標。
- **實時分享仲未做真機驗證**（sandbox 冇 Cloudflare 憑證、亦冇兩部手機）：`wrangler deploy` 之後要 smoke test `POST /api/live` 同 WS upgrade（`run_worker_first` 同 static assets 嘅互動，PLAN §6.1 標明「待驗證」）、用 WhatsApp / 短訊實傳 link 確認 `#` 後面嘅 key 完整、iOS 分頁被丟棄後還原靠 `sessionStorage` 重連、以及中轉延遲 p95。
- 移動中（步行 / 車行 / 隧道）嘅定位準確度**未量度**：`src/lib/fixLog.ts` 嘅 CSV（`?debug=1` 可以複製）已經有 speed / heading，需要真實紀錄先可以調 §4.2 嘅門檻。

## 🔒 私隱

- 冇帳戶、冇 cookies、冇追蹤。定位同查地址完全喺瀏覽器做。
- 位置只會送去政府 API（identify、searchNearby、ALS，同埋地政總署地圖瓦片）用嚟查地址 / 顯示地圖；只有你撳「分享」先會傳俾你揀嘅人。
- 例外：開「立體圖」會向 OpenFreeMap 要建築物圖磚（只含畫面範圍）。
- **實時分享（要主動 opt-in 先會開始）**：座標經 i-here 嘅 Cloudflare Worker 中轉，但**全部係 AES-GCM 密文**，key 只喺 link 嘅 `#` fragment（唔會送去 server），所以 server 睇唔到亦儲唔到座標。房間 30 分鐘自動結束，隨時可以停止或者踢走對方；房間關閉即所有資料消失（DO 記憶體 + 一個到期時間，冇座標 log）。server 仍然會見到連線元數據（IP、時間、訊息大細），呢啲喺香港《個人資料（私隱）條例》下亦可能算個人資料 —— 所以入口預設關閉、開始前要明確同意。
- **注意**：join link 本身係 bearer secret —— **有完整 link 嘅人都睇到你嘅位置**，只傳俾你信任嘅人。

---

地圖資料 © 地政總署；地址資料 © OGCIO 門牌地址搜尋服務；建築物高度 © OpenStreetMap contributors。本項目與香港特區政府無關。
