# 區域網路同步——開發者指南

Luker 區域網路同步功能的技術參考文件。面向使用者的說明見 [區域網路同步](/zh-TW/improvements/lan-sync)；設計依據和協定協商規則見 `docs/superpowers/specs/lan-sync.md` 中的規範文件。

## 一段話講完架構

每個 Luker 使用者都會為每個已配對的對端維護一份**影子 git 倉庫**，存放在 `data/<handle>/.sync/<peer-id>/` 下。同步在發起方按四步流水線進行：把活動資料快照寫入影子工作目錄、透過 HTTP 抓取對端缺失的 git 物件、嘗試三向合併、把合併結果反向同步回活動儲存。回應方在 offer 階段執行對稱的快照，並在發起方推送落到 `refs/heads/main` 後執行尾部反向同步。v1 中所有衝突都是檔案層級——沒有欄位層級的合併。

## 檔案佈局

```
data/<handle>/.sync/
├── state.json                  對端註冊表、最近同步時間戳記、按對端記錄的分類選擇
└── <peer-id>/
    ├── repo.git/               裸 git 資料庫，儲存該對端的同步歷史
    └── workdir/                工作目錄，鏡像該使用者已啟用的分類
```

影子倉庫與活動資料相互獨立。協調器在每次同步前把活動資料複製到影子，並在每次成功合併後把影子寫回活動。裸 `repo.git` 與物化的 `workdir` 組成一個**分離佈局**倉庫：同步程式碼裡的每次 isomorphic-git 呼叫都會同時傳 `dir: shadow.workdir` 與 `gitdir: shadow.gitDir`，因為 `.git` 並不巢狀在工作目錄內。

`state.json` 透過 `write-file-atomic` 原子重寫。輔助函式位於 `src/sync/state.js`——`readSyncState`、`recordPeer`、`recordSyncCompletion`、`removePeer`、`removePeerCompletely`。該檔案保存每個對端的 `categories` 選擇，`runPull` 與 `undoLastSync` 直接複用，讓後續同步沿用使用者當初的選擇，無需反覆確認。`recordPeer` 還會持久化 `peerBaseUrl`，以便 `/peers/:peerId/sync`（UI 的「立即同步」）下次能直接重跑同步，不必再次詢問對端位址。`removePeerCompletely` 會同時刪除註冊表條目和 `<userRoot>/.sync/<peerId>/` 下的影子目錄——遺留的 `removePeer` 只更新 `state.json`，會留下孤兒影子目錄。

## 線協定

所有端點位於 `/api/sync/v1/` 下。token 認證使用 `Authorization: Bearer <token>` 請求標頭。Token 是 64 位十六進位字串，有效期 10 分鐘，在 `/session/close` 之前可多次使用。

| 方法 | 路徑 | 驗證 | 用途 |
|---|---|---|---|
| `GET`  | `/health`                | Basic         | 存活探針，回傳 `{ ok: true }` |
| `POST` | `/session/offer`         | Basic         | 回應方鑄造工作階段 token，並把自身活動資料快照寫入影子工作目錄；回傳 `{ url, token, expiresAt, peerId, label }` |
| `GET`  | `/session/manifest`      | 工作階段 token | 發起方取得 `{ handle, peerId, expiresAt, headOid }` |
| `GET`  | `/session/object/:oid`   | 工作階段 token | 發起方取得單個 git 物件；body 是原始內容，`X-Object-Type` 與 `X-Object-Oid` 請求標頭攜帶中繼資料 |
| `POST` | `/session/object`        | 工作階段 token | 發起方上傳單個 git 物件；`X-Object-Oid` 與 `X-Object-Type` 請求標頭加原始 body，請求主體直接從請求串流寫入 `<gitdir>/objects/incoming/` 下的暫存檔（不會把整個 body 快取到記憶體） |
| `POST` | `/session/ref`           | 工作階段 token | 發起方以 compare-and-swap 方式原子更新 ref（不相符時回傳 409，帶 `currentOid`）；當 ref 為 `refs/heads/main` 時，回應方會執行一次尾部反向同步，把變更寫回自己的活動樹 |
| `POST` | `/session/close`         | 工作階段 token | 立即作廢 token |
| `POST` | `/pull`                  | Basic         | 發起方入口：驅動針對某個對端 offer 的完整同步流程 |
| `POST` | `/undo`                  | Basic         | 把指定對端回滾到最近一個 `sync-backup-*` 標籤 |
| `GET`  | `/peers`                 | Basic         | 回傳目前使用者的對端註冊表（label、categories、pairedAt、lastSyncAt、lastSyncedOid、peerBaseUrl） |
| `GET`  | `/categories`            | Basic         | 回傳 `SYNC_CATEGORIES` 的形狀，供 UI 渲染分類選擇器，無需在前端打包列表 |
| `DELETE` | `/peers/:peerId`       | Basic         | 同時刪除註冊表條目和 `<userRoot>/.sync/<peerId>/` 下的影子目錄；冪等 |
| `POST` | `/peers/:peerId/label`   | Basic         | 更新對端的 label/categories 而不重設 `pairedAt` |
| `POST` | `/peers/:peerId/sync`    | Basic         | 「立即同步」：用註冊表中儲存的 `peerBaseUrl` 重跑同步，使用者無需重新輸入 URL |
| `POST` | `/pair/start`            | Basic         | 配置新的 peerId、本地註冊，回傳 `{peerId, label, peerBaseUrl, categories}`，供 UI 渲染為配對連結 |
| `POST` | `/pair/accept`           | Basic         | 消費配對連結：呼叫對端的 `/session/offer` 申請 token，本地註冊對端，執行首次 `runPull` |

工作階段 token 路徑（即 `/api/sync/v1/session/*`，但不含 `/session/offer`）透過 `src/middleware/basicAuth.js` 的 `SYNC_SESSION_PATH_PATTERN` 繞過標準 basic-auth 中介軟體。`/session/*` 同時在 `src/server-main.js` 的 `skipCsrfProtection` 中豁免 CSRF 保護，以便 `/pair/accept` 與 `/peers/:peerId/sync` 的伺服器到伺服器 `fetch` 呼叫能命中對端的 `/session/offer`，而無需攜帶按工作階段繫結的 CSRF token。`/session/offer` 自身仍在 basic-auth 流程內，以便 `req.user` 已填充——這正是把發出去的 token 繫結到已驗證 handle 的關鍵。`/pull`、`/undo`、`/pair/*`、`/peers*` 同樣走 basic-auth。

### 線格式約束

- **物件大小**：線格式上沒有上限。`POST /session/object` 不掛任何 body parser；`writeObjectFromWireStream` 把請求主體管線寫入 `<gitdir>/objects/incoming/` 下的暫存檔，再把檔案內容交給 `git.writeObject`。傳輸期間回應方的堆積記憶體不會隨 body 大小增長——背壓透過管線傳遞，核心依需求把暫存檔分頁換入換出。暫存檔在成功和失敗路徑上都會被刪除。
- **物件完整性**：`writeObjectFromWire`（緩衝版本）與 `writeObjectFromWireStream`（串流版本）都會對 body 重新做雜湊並和傳入的 `oid` 比對，不一致時在物件進入任何 ref 之前拋出，串流版本還會在失敗路徑上刪除暫存檔；`fetchMissingObjects` 把**請求的** oid（而不是回應方在 `X-Object-Oid` 中宣稱的 oid）傳給寫入函式，這樣即便回應方關於某物件身分撒謊，也無法汙染本地資料庫。
- **對端抓取逾時**：協調器發往對端的 `fetch` 都帶 `AbortSignal.timeout(30_000)`。逾時會變成一個型別化的 `PEER_TIMEOUT` 錯誤，`/pull` 將其對應為 HTTP 504。沒有這層防護，對端在同步過程中走出 Wi-Fi 覆蓋時，會因 OS 預設 TCP 逾時（數分鐘）卡住整個 per-key 同步佇列。
- **`/session/offer` body 上限**：`express.json({ limit: '16kb' })`——offer 酬載只包含 peerId、label 和 categories 陣列，16 KB 足夠寬裕。
- **`/pull` body 上限**：`express.json({ limit: '1mb' })`——大量檔案衝突時 resolutions 物件會變大，1 MB 留足空間。

## 分類註冊表

`src/sync/categories.js` 匯出唯一的 `SYNC_CATEGORIES` 陣列。每個條目把一個 id 對應到一組路徑（透過 `UserDirectoryList` 存取器解析），並宣告預設值（`on` / `opt-in` / `never`）與衝突模式（`file` / `none`）。所有 UI 標籤和警告都是 i18n key，執行時絕不內嵌英文字串。

目前註冊表涵蓋：`characters`、`chats`、`worlds`、`card-apps`、`skills`、四個預設家族（`openai-presets`、`novelai-presets`、`koboldai-presets`、`textgen-presets`）、四個範本家族（`instruct`、`context`、`sysprompt`、`reasoning`）、`themes`、`movingUI`、`quickreplies`、`assets`、`backgrounds`、`avatars`、`user-files`、`user-images`、`image-metadata`、`vectors`、`stats`、`settings`、`secrets`、`extensions`。

新增一個分類：

1. 在 `SYNC_CATEGORIES` 增加一個條目。
2. 在 `public/locales/{zh-CN,zh-TW,en}.json` 加上對應 i18n key。
3. `tests/sync/categories.test.js` 中的形狀測試會抓出缺失的 locale 字串。

## 儲存模式處理

工作目錄是通用交換格式。已經把每使用者資料落到磁碟的引擎可以略過物化；把資料存到資料庫的引擎會在快照之前把紀錄投影到工作目錄，反向同步之後再讀回。從同步流水線的視角看，每種引擎都只是檔案。

- **`fs`**：每使用者資料已經位於 `<userRoot>` 下與工作目錄相對路徑一一對應的位置。`snapshotLiveToShadow` 直接走訪活動樹並複製到影子工作目錄；反向同步的寫入都走 `write-file-atomic`，當機時舊檔案保持完好。
- **`sqlite`** / **`mysql`** / **`postgres`**：每使用者資料（聊天、預設、世界書、命名文件、設定、統計、群組）儲存在引擎內。在快照之前，協調器呼叫 `materializeUserDataIntoWorkdir`（`src/sync/materialize.js`），透過 repo 層讀取每個啟用分類，並把每筆紀錄作為檔案寫入 `<workdir>/<expected-rel-path>`，佈局與 FS 引擎完全一致。`snapshotLiveToShadow` 隨後透過傳入 `liveRoot: shadow.workdir` 把工作目錄當作活動樹來走訪。反向同步之後，`dematerializeWorkdirIntoUserData` 讀回（可能已合併的）工作目錄狀態，並透過 repo 層逐筆儲存。在每種引擎中都落到磁碟的分類（characters、avatars、assets……）會略過物化器，由快照走訪器直接處理。

在所有引擎裡，每個分類的衝突模式都是 `file`——聊天對聊天、世界書對世界書、按紀錄處理——所以合併 UI 與解決語意並不取決於儲存引擎。

## 衝突解決流程

`git.merge` 拋出 `MergeConflictError` 時，`src/sync/conflicts.js` 中的 `attemptMerge` 會走訪 `error.data` 並回傳：

```js
{
    success: false,
    conflicts: [
        { filepath, kind, oursOid, theirsOid },
        ...
    ],
}
```

`kind` 是 `bothModified`、`deleteByUs`、`deleteByTheirs` 中的一種。`deleteByUs` 時 `oursOid` 為 `null`；`deleteByTheirs` 時 `theirsOid` 為 `null`。協調器把衝突集合以 `{ ok: false, conflicts }` 形式向上傳播，`/pull` 直接作為 JSON 回傳；UI 逐條呈現衝突，使用者為每個檔案挑選一側。後續呼叫 `/pull` 時附帶 `resolutions: { filepath: 'ours' | 'theirs' }`，會觸發 `applyResolutions`，把選定的 blob 寫入工作目錄並產生一個雙父合併提交。

`attemptMerge` 還兜底處理 `git.merge` 不擅長的兩種情形。**快進（向前/向後）**：`src/sync/orchestrator.js` 中的 `isAncestor` 透過 `git.log` 偵測本機與對端 head 之間是否存在嚴格線性關係，命中則直接 `writeRef` + `checkout` + 反向同步，不產生合併提交。**無公共祖先**：兩側各自的首次快照都是根提交時，`git.merge` 會丟出 `MergeNotSupportedError`。`attemptMerge` 捕獲後將對稱差合成為按檔案維度的衝突集合（僅出現在一側的檔案變成 `deleteByX`，兩側 blob oid 不同的檔案變成 `bothModified`），形狀仍是 `{ ok: false, conflicts }`，UI 端統一處理。

合併失敗之後，協調器**不會**呼叫 `git.checkout`。此時工作目錄處於合併進行中狀態，自動合併的檔案已經就位；做一次 checkout 會把它們抹掉。`applyResolutions` 只覆寫衝突檔案，並透過 `writeAndStage` 暫存，讓僅出現在某一側的檔案得以保留。

乾淨（無衝突）的合併之後，`git.merge` 會更新 `refs/heads/main` 和索引，但**不會**碰觸工作目錄，因此協調器會明確執行 `git.checkout({ ref: 'main', force: true })`，再讓 `reconcileShadowToLive` 從工作目錄讀回活動資料。

## 復原

每次 pull 之前，協調器都會把目前影子 `main` 打成 `sync-backup-<ISO timestamp>` 標籤（其中 `:` / `.` 取代為 `-`，保證標籤名稱在檔案系統上安全且按字典序可排序）。首次配對時跳過（此時還沒有 `main` 可以錨定）。

`POST /undo` 會走訪符合 `sync-backup-*` 的標籤，排序後取最新的一個，把 `main` 指向該標籤的提交，透過 `git.checkout` 把樹物化到工作目錄，再以該對端最近記錄的分類選擇為範圍執行 `reconcileShadowToLive`。標籤到提交的對應關係是真相來源；活動資料透過反向同步剛回滾的影子重建。

如果沒有任何 `sync-backup-*` 標籤（例如某對端只做過一次同步，而首次配對的 pull 不會打標籤），`undoLastSync` 會拋出 `NO_BACKUP_TAG`，`/undo` 將其對應為 HTTP 404。

撤銷嚴格限於本地——只觸碰本側資料。對端在下次同步之前完全不受影響。

## 鎖

協調器對每一個會修改某配對活動資料的操作都使用一條 **per-`(userRoot, peerId)` FIFO 佇列**：本側的 `runPull` 呼叫，以及來自對端 `/session/ref` 推送觸發的回應方反向同步。佇列鍵使用 `userRoot` 而非 `handle`，這樣兩個共用 handle 的使用者（測試工具、未來的多租戶情境）會繫結到各自的物理資料根、得到相互獨立的佇列。

佇列只**等待**而不拋錯。同一個 `(userRoot, peerId)` 的第二次 `/pull` 會阻塞在前一次之後，而不是回傳 409——這符合使用者「按兩次同步按鈕自然就行」的心理模型，也能與對端觸發的回應方反向同步正確串列。佇列尾部以 `.catch` 吞掉例外，單次失敗不會汙染後續每一次入佇列。

正式的佇列輔助函式是 `queueOnKey(key, fn)` 與 `syncQueueKey(userRoot, peerId)`，都從 `src/sync/orchestrator.js` 匯出。同步 HTTP 層對 `/session/ref` 反向同步使用同一個 key，從而讓對端在本側 `runPull` 進行中到達的推送等待本地 pull 完成。

### 沒有被鎖住的情境

配對到同一使用者的兩個不同對端（筆電 + 手機）使用不同的 `(userRoot, peerId)` 鍵，因此可以平行對同一使用者的活動樹執行反向同步。`write-file-atomic` 保證單檔案寫一致性；該情境下的跨檔案一致性由使用者自己負責（不要並行跑兩個同步）。按 spec §4.4，一把 per-userRoot 的活動寫鎖才能徹底涵蓋這種情形，但 v1 暫不引入這麼多複雜度。

Spec §4.4 還描述了一個全應用範圍的 `SYNC_IN_PROGRESS` 閘門，在同步視窗期間對使用者主動觸發的寫入端點（`/api/chats/save`、`/api/settings/save`、`/api/presets/save` 等）統一回傳 HTTP 409。這個閘門防止活動資料樹在協調器執行 snapshot → merge → reconcile 期間被使用者寫入移動；否則會出現「同步期間編輯的內容憑空消失」（被 snapshot 擷取，又被 reconcile 覆蓋）這種失敗模式，而且在 SQL 引擎模式下，物化與反物化之間若有使用者寫入落地，工作目錄與引擎紀錄集會出現不一致。

閘門位於 `src/sync/in-progress-gate.js`，在 `src/server-main.js` 中掛載於 `requireLoginMiddleware` 之後。它是**按 handle 隔離**的：handle `A` 的同步進行中，不會阻塞 handle `B` 的寫入。協調器在 `queueOnKey` 回呼內部標記 `(handle, peerId)` 進行中（讓佇列中**等待**的拉取不會預先 409 使用者寫入），並在 `try/finally` 中清除（讓拋出的錯誤、對端逾時、待解決衝突的提前回傳都能釋放閘門）。三個協調器入口點參與了這一邏輯：`runPull`、`undoLastSync` 以及對端 `/session/ref` 觸發的回應方 reconcile。

被閘門保護的路徑名單是保守的：每一個寫入磁碟 `data/<handle>/` 的 POST/PUT/PATCH/DELETE 都在列；讀端點（`/get`、`/list`、`/recent`、`/search`）**不**被閘門攔截，讓 UI 在同步執行期間仍能展示資料。被拒的寫入收到一個結構化的 409 body（`{error: 'SYNC_IN_PROGRESS', retryAfterMs, peers}`）和一個 `Retry-After` HTTP 標頭，讓客戶端能為重試加上去抖。

閘門**不**涵蓋的情境：兩個綁定到同一 handle 的對端（筆電 + 手機）同時向同一使用者的活動樹推送——跨對端競爭。每個 `(userRoot, peerId)` 對都有獨立的佇列，`write-file-atomic` 保證單檔案寫入跨這個邊界仍然一致，但跨檔案一致性在此情境下由使用者負責（不要並行執行同一 handle 的兩個同步流）。

## 效能特徵

典型使用者（約 3000 個檔案，約 100 MB）的表現：

- **首次配對**：數秒（快照 + 初始提交 + 全樹物件傳輸）。耗時主要花在把每個檔案從磁碟讀出來做雜湊；後續操作只會重新雜湊 mtime 改變過的檔案。
- **增量同步**：變更集較小時遠低於一秒。線上開銷只與新增 git 物件數量有關，與活動資料總量無關——一次輸入的角色訊息只會改一個 `chat_*.jsonl`，搬運一個新 commit、每個被觸及目錄一個新 tree、加上一個新 blob。
- **小型同步的線上總量**：通常合計幾 KB（commit + 幾個 tree + 變更的 blob）。
- **影子 `.git` 目錄**：大約是已同步活動資料大小的 40%；git 自帶的 zlib 在 Luker 資料中占主導的小 JSON 檔案上壓縮得很好。

## 原始檔清單

- `src/sync/categories.js`——同步資料分類註冊表
- `src/sync/session.js`——token 快取（沿用 `src/lan-migration.js` 的模式）
- `src/sync/shadow.js`——影子路徑、`ensureShadowRepo`、`snapshotLiveToShadow`、`reconcileShadowToLive`
- `src/sync/objects.js`——線格式編解碼（`readObjectForWire`、`writeObjectFromWire`、`writeObjectFromWireStream`）與物件圖走訪（`fetchMissingObjects`、`hasObjectLocally`）
- `src/sync/conflicts.js`——`attemptMerge` 與 `applyResolutions`
- `src/sync/materialize.js`——`materializeUserDataIntoWorkdir` / `dematerializeWorkdirIntoUserData`，服務於 sqlite/mysql/postgres 引擎（fs 模式下為 no-op）
- `src/sync/state.js`——`state.json` 讀寫輔助函式
- `src/sync/orchestrator.js`——`runPull`、`undoLastSync`、`queueOnKey`、`isAncestor`
- `src/sync/in-progress-gate.js`——按 handle 隔離的 `SYNC_IN_PROGRESS` 註冊表與 Express 中介軟體（spec §4.4）
- `src/endpoints/sync.js`——`/api/sync/v1/*` 的 HTTP 路由
- `src/middleware/basicAuth.js`——`SYNC_SESSION_PATH_PATTERN`，用於驗證繞過
- `src/server-main.js`——`/api/sync/v1/session/*` 的 CSRF 跳過規則，讓伺服器到伺服器的對端 fetch 可用
- `public/scripts/lan-sync.js` + `public/scripts/templates/userLanSync.html`——UI 面板，入口路徑：帳號 → 備份與還原 → 區域網路同步

## 測試

- `tests/sync/*.test.js`——每個模組的單元覆蓋
- `tests/sync/integration/*.test.js`——透過 supertest 完成的兩伺服器整合測試，包含配對、同步、衝突、解決、撤銷的全鏈路往返
