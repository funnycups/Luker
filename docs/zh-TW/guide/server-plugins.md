# 伺服端外掛

伺服端外掛是執行於 Luker 伺服端處理程序內的 Node.js 模組。前端擴充功能執行於瀏覽器，伺服端外掛則可讀寫伺服端檔案系統、使用 Node.js 模組、代理外部 API 請求。外掛路由掛載於 `/api/plugins/{plugin-id}/` 下。

::: warning
伺服端外掛沒有沙箱隔離。外掛與伺服端處理程序擁有相同權限，請僅安裝可信任來源的外掛。
:::

## 啟用伺服端外掛

伺服端外掛預設關閉，於 `config.yaml` 中開啟：

```yaml
enableServerPlugins: true
```

修改後重新啟動 Luker。

## 開啟伺服端外掛分頁

該分頁位於管理面板，僅管理員可見。

1. 開啟**使用者設定**。
2. 選擇**管理面板**。
3. 選擇**伺服端外掛**分頁。

![管理面板中的伺服端外掛分頁](/images/server-plugins/01-server-plugins-tab.png)

分頁列出已安裝的外掛，顯示其目錄、版本、套件中繼資料與 Git 遠端。

## 從 Git 位址安裝

將儲存庫位址貼到 **Git 儲存庫位址**欄位，然後選擇**安裝**。

![已填入 Git 儲存庫位址](/images/server-plugins/02-repo-url-entered.png)

Luker 會將儲存庫克隆到外掛目錄並加入清單。新安裝的外掛需重啟後端才會載入。

## 安裝依賴

外掛宣告 npm 依賴時，Luker 會在安裝後檢查，並提示安裝缺少的依賴。

![提示安裝缺少的依賴](/images/server-plugins/03-dependency-prompt.png)

選擇**安裝依賴**進行安裝。桌面端優先執行系統 `npm`，`npm` 無法使用時回退到內建安裝器；Android 端使用內建安裝器，無需終端機。選擇**取消**則維持未安裝狀態，外掛列會顯示缺少數量與**安裝依賴**按鈕。

![顯示缺少依賴與安裝按鈕的外掛列](/images/server-plugins/04-dependencies-missing.png)

僅當外掛宣告尚未安裝的依賴時，外掛列才會顯示**安裝依賴**按鈕。依賴就緒後，外掛列顯示**依賴已安裝**並隱藏該按鈕。未宣告依賴的外掛不顯示依賴狀態與按鈕。

![安裝依賴後的外掛列](/images/server-plugins/05-dependencies-installed.png)

## 重新啟動後端

外掛在啟動時載入。安裝或更新外掛後，重新啟動 Luker 才會載入。主控台會記錄載入的外掛：

```
[Plugin Loader] Loaded plugin: My Plugin (my-plugin)
```

## 驗證外掛路由

伺服端外掛路由掛載於 `/api/plugins/{plugin-id}/` 下。請求外掛的某個路由即可確認其已載入。對於 id 為 `hello-world`、提供 `GET /hello` 路由的外掛：

```bash
curl http://localhost:8000/api/plugins/hello-world/hello
```

傳回 JSON 即表示外掛正在執行。

## 手動安裝

也可將外掛檔案或目錄直接放入外掛目錄，預設位於專案根目錄的 `plugins/`，然後重新啟動 Luker。為手動放置的外掛安裝依賴時，可在伺服端外掛分頁使用其**安裝依賴**按鈕，或在桌面端於外掛目錄內執行 `npm install`。

## 疑難排解

### 依賴缺少

外掛因依賴缺少而載入失敗時，在伺服端外掛分頁從對應外掛列安裝依賴，然後重新啟動 Luker。

### 原生模組

部分 npm 套件在安裝時編譯原生程式碼。Android 端的安裝不執行建置指令碼，因此需要編譯原生程式碼的套件無法在 Android 端安裝。請先在桌面端安裝此類套件，再將外掛目錄複製到裝置。

### Git 無法使用

系統 Git 無法使用時，Luker 使用內建實作克隆 HTTP(S) 位址；SSH 位址需要系統 Git。克隆 SSH 位址失敗時，安裝 Git 後重新安裝此外掛。

## 相關頁面

- [伺服端外掛開發](/zh-TW/development/server-plugin) — 為 Luker 建置伺服端外掛
- [基礎配置](/zh-TW/guide/configuration) — 配置參考
