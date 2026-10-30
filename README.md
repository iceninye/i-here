# 📍 我在哪裡 · i-here

**一打開就知道自己身處何方，一鍵分享位置給家人。**

好多時屋企人（尤其係長者）喺街上會唔知自己喺邊。i-here 打開即定位，用**大字**顯示「你現在位於：興輝樓附近」同官方門牌地址，再撳一個**大綠色掣**就可以用 WhatsApp / 短訊 / Telegram 將精準位置傳俾家人。

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
坐標轉換 API  wgsgeog → hkgrid   （3 秒 timeout；失敗用本機 proj4 EPSG:2326，誤差 ~1 m）
  ▼
identify API（www.map.gov.hk；失敗試 geodata.gov.hk 鏡像）  ┐ 並行
searchNearby API（1 km 內設施）                              ┘ → 揀最近嘅地方名
  ▼   （政府 API 全部攞唔到地名 → OpenStreetMap Nominatim 後備）
  ▼
ALS 門牌地址搜尋（用最近建築物名查）→ 揀 250 m 內最近嗰個 → 官方中文地址
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

收件人撳 i-here 連結會見到地政總署地圖上嘅紅色「家人」標記，同一個「用 Google 地圖導航前往」掣；**唔會即刻彈定位權限**嚇親人，要自己撳「看看我自己的位置」先定位。

## 4. UI / UX：慌亂中都一眼睇得明

- **一個畫面、一個主要動作**：上面係位置卡，中間係地圖，下面係成個闊度、80 px 高嘅綠色「分享我的位置」。
- **大字**：地名 28–38 px 粗體，地址 20 px；全部用 `rem`，跟手機「字體大小」設定放大。
- **用說話，唔用術語**：「很準確（約 18 米內）」而唔係「±18 m」；冇「HK80」「座標」呢啲字眼。
- **標記有字**：藍色「我」、紅色「家人」，唔使識睇藍點。
- **防誤觸**：停用地圖旋轉；拖動地圖後出現「回到我的位置」，唔會自己飛走。
- **出錯都有路行**：權限被拒時直接教 iPhone / Android 點開；冇地址時講明「仍然可以分享」。
- **無障礙**：位置卡 `aria-live` 會被讀屏器讀出；按鈕有文字（emoji 設 `aria-hidden`）；焦點框 4 px 黃色；`prefers-reduced-motion` 停動畫；觸控目標 ≥ 56 px。

## 5. CORS 與部署注意事項

### 跨域（CORS）

| API | 瀏覽器直接 call | 備註 |
|---|---|---|
| 地圖瓦片 `mapapi.geodata.gov.hk` | ✅ 一般得 | `<img>`/WebGL 載入，地政總署瓦片有 CORS header |
| identify `www.map.gov.hk` / searchNearby `geodata.gov.hk` | ⚠️ 未實測 | 失敗會自動試鏡像，再退 OpenStreetMap |
| ALS `www.als.gov.hk` | ⚠️ | 要加 `Accept: application/json`，否則回 XML |
| 坐標轉換 `geodetic.landsd.gov.hk` | ⚠️ | 失敗時 App 自動用本機 proj4，唔影響功能 |

**最佳做法**：

1. **App 本身已經容錯**：每個 API 都有 timeout、`AbortController`、後備路徑（proj4 / 只顯示座標），API 全部失敗都照樣可以分享位置。
2. **遇到 CORS 就開代理**：`worker/` 係一個 Cloudflare Worker（mtr-app 已經用緊 Cloudflare）：
   - 只准 3 個政府 host（**唔係 open proxy**）、只准 `GET`、Origin 白名單。
   - Edge cache 24 小時（地址唔會分鐘級改變），減少政府 API 負荷同限流風險。
   - 部署：`cd worker && npx wrangler deploy`，然後設定 `VITE_API_PROXY`。
3. **唔好用公共 CORS proxy**（cors-anywhere 之類）：位置係敏感資料，唔應該經第三方。
4. **HTTPS 必須**：Geolocation 同 Web Share API 只喺 HTTPS / `localhost` 用得。GitHub Pages、Vercel、Cloudflare 都預設 HTTPS。
5. **Rate limit**：只喺移動 > 40 m 先重新查地址；Worker cache 再擋一層。
6. **PWA / Service Worker**：如果之後加 SW，**唔好 cache 定位 API 回應**（會顯示舊地址），只 cache app shell 同地圖瓦片（`StaleWhileRevalidate`，設上限）。
7. **Base path**：`vite.config.ts` 用 `base: './'`，同一份 build 放 GitHub Pages（`/i-here/`）或根目錄都得。

### 部署

- **GitHub Pages**：push 去 `main` 自動 build + 部署（`.github/workflows/deploy.yml`）。第一次要喺 repo **Settings → Pages → Source** 揀 **GitHub Actions**。
- **Cloudflare Workers Builds**：根目錄 `wrangler.jsonc` 會先跑 `npm run build`，再將 `dist/` 當靜態資源部署（同 mtr-app 一樣冇 Worker script）。
- 可選 Actions variables：`VITE_API_PROXY`、`VITE_LANDSD_3DTILES_URL`（見 `.env.example`）。
- PR 會自動跑測試同 build（`.github/workflows/ci.yml`）。

## 🛠️ 本機開發

```bash
npm install
npm run dev        # http://localhost:5173（定位要 localhost 或 HTTPS）
npm test           # 單元測試（定位取樣、HK80 轉換、地址解析、分享文字）
npm run build
```

手機實測：`npm run dev -- --host`，再用 `ngrok` / Cloudflare Tunnel 開 HTTPS。

## 🗂️ 檔案結構

```
src/
  hooks/useCurrentLocation.ts   定位 → HK80 → 地標 / 地址（核心 hook）
  lib/geo.ts                    取樣窗定位、範圍檢查、距離（移植自 mtr-app）
  lib/hk80.ts                   坐標轉換 API + proj4 後備
  lib/reverseGeocode.ts         identify API + ALS 地址補全
  lib/shareText.ts              分享訊息、WhatsApp / SMS / 收件人連結
  components/ShareButton.tsx    Web Share API + 後備選單
  components/LocationCard.tsx   大字位置卡
  components/MapView.tsx        MapLibre 地圖、精度圈、2D / 3D
  components/landsd3dTiles.ts   地政總署 3D Tiles（lazy）
wrangler.jsonc                  Cloudflare Workers Builds 靜態部署設定
worker/                         可選 CORS 代理（Cloudflare Worker）
```

## ⚠️ 已知限制 / 待驗證

- 開發環境網絡封鎖咗 `*.gov.hk`，**identify / searchNearby / ALS / 坐標轉換 API 嘅回應格式未對真實 API 實測**（官方文件冇公開 response schema）。解析器好寬鬆：遞迴搵任何「似地方名」嘅欄位（中文優先），有座標就計距離。
- **排查方法**：網址加 `?debug=1`（例如 `https://iceninye.github.io/i-here/?debug=1`），位置卡下面會出「診斷資料」，顯示每個 API 嘅狀態（`TypeError` 多數係 CORS）同回應頭 600 字，可以一鍵複製。
- 輕量 3D 建築物用 OpenStreetMap 高度數據（OpenFreeMap 向量瓦片），香港覆蓋率高但唔係官方。地政總署「3D 建築物外廓」係下載檔（非瓦片 API），之後可以預先轉成 PMTiles 放 repo 取代。
- 地政總署 3D Tiles 嘅高度係真實海拔，MapLibre 冇開地形時山上嘅建築物會「浮起」；屬可選功能。
- 北區同深圳交界一帶，經緯度範圍檢查無可避免會重疊；嗰度 identify 搵唔到大廈就只顯示座標。

## 🔒 私隱

- 冇後端、冇帳戶、冇 cookies、冇追蹤。
- 位置只會送去政府 API（或你自己部署嘅 Worker）用嚟查地址；只有你撳「分享」先會傳俾你揀嘅人。

---

地圖資料 © 地政總署；地址資料 © OGCIO 門牌地址搜尋服務；建築物高度 © OpenStreetMap contributors。本項目與香港特區政府無關。
