# 圖像生成 API

`context.imageGeneration` 依三層一致性暴露 Luker 結構化圖像生成能力，涵蓋預設層使用者參考開關與後端底層協定探測、生圖預設切換、參考圖多協定路由、多角色分區提示詞以及圖像歸屬控制。

## 三層 API 暴露

```js
// Layer 1 —— 核心模組直接 ESM 匯入
import { imageGenerationApi } from '/scripts/image-generation/registry.js';

// Layer 2 —— lukerContext / Luker.getContext() / 擴充 API 註冊表
const imageGen = Luker.getContext().imageGeneration;
const sdApi = Luker.getContext().getExtensionApi('sd');

// Layer 3 —— CardApp 沙箱上下文
const cardImageGen = ctx.imageGeneration;
```

CardApp 內的 `ctx.imageGeneration.generate` 預設將 `attribution` 設為 `'active_chat'`；生成獨立於目前聊天的資產時可顯式傳入 `attribution: 'none'`。

## 可用性與後端能力探測

```ts
imageGeneration.isAvailable(): boolean
imageGeneration.getCapabilities(): Promise<ImageCapabilities>
```

`ImageCapabilities` 同時傳回目前生圖預設的使用者開關狀態、底層後端與工作流 `protocol` 能力以及配置衝突 `warnings`：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `source` | `string` | 目前生圖來源識別碼，例如 `'google'`、`'chat_image'`、`'openai'`、`'openrouter'`、`'xai'`、`'novel'`、`'comfy'`、`'auto'` 或 `'vlad'` |
| `model` | `string` | 目前生圖模型識別碼 |
| `characterReferenceEnabled` | `boolean` | 目前生圖預設是否啟用角色庫參考 |
| `characterReferenceMode` | `'text_only' \| 'image_only' \| 'text_and_image'` | 目前生圖預設設定的角色參考傳遞方式 |
| `supportsCharacterTextReference` | `boolean` | 當 `characterReferenceEnabled` 為 `true` 且 `characterReferenceMode` 為 `'text_only'` 或 `'text_and_image'` 時為 `true` |
| `supportsCharacterReference` | `boolean` | 使用者開關態能力：當 `characterReferenceEnabled` 為 `true` 且 `characterReferenceMode` 為 `'image_only'` 或 `'text_and_image'` 時為 `true` |
| `maxCharacterReferences` | `number \| null` | 面向呼叫方的單次角色參考圖上限：未啟用時為 `0`；啟用時取 `protocol.maxCharacterReferences`，且在 `protocol.sharedReferenceSlots` 為 `true` 時扣減目前已啟用的畫風參考數量；協定無固定上限時為 `null` |
| `supportsStyleReference` | `boolean` | 使用者開關態能力：目前生圖預設是否啟用畫風與氛圍參考 |
| `maxStyleReferences` | `number \| null` | 未啟用畫風參考時為 `0`，啟用時取 `protocol.maxStyleReferences` |
| `supportsSourceImage` | `boolean` | 使用者開關態能力：目前生圖預設是否允許圖生圖底圖編輯 |
| `supportsMultiCharacterPrompts` | `boolean` | 映射 `protocol.supportsMultiCharacterPrompts`：是否支援 `characterPrompts` 多角色分區提示詞與座標 |
| `supportsDynamicAspectRatio` | `boolean` | 映射 `protocol.supportsDynamicAspectRatio`：是否支援按次覆寫 `aspectRatio` 畫幅比例 |
| `availableLoras` | `{ names: string[], includeWeight: boolean }` | 目前 ComfyUI 工作流暴露的動態 LoRA 清單 |
| `protocol` | `ProtocolCapabilities` | 獨立於使用者開關的後端與工作流協定能力，包含 `supportsCharacterReference`、`maxCharacterReferences`、`supportsStyleReference`、`maxStyleReferences`、`supportsSourceImage`、`supportsMultiCharacterPrompts`、`supportsDynamicAspectRatio`、`sharedReferenceSlots`、`maxTotalReferences`、`comfyReferenceSlotCount` 與 `comfyWorkflowError` |
| `warnings` | `Array<{ code: string, message: string, affects: Array<'character_image' \| 'style' \| 'source'> }>` | 已開啟的參考開關與目前生圖後端 `protocol` 或 ComfyUI `%ref_image%` 節點之間的配置衝突清單 |

頂層 `supportsCharacterReference`、`supportsStyleReference` 與 `supportsSourceImage` 表示目前生圖預設中由使用者開關決定的能力狀態，供 AI agent 與介面按鈕門控讀取；`protocol.supports*` 則表示目前生圖後端、模型與 ComfyUI 工作流在協定層實際支援的輸入能力。顯式呼叫 `generate({ references })` 時，傳入的 `references` 以及在 `supportsStyleReference` 與 `includePresetStyleReferences` 均開啟時合併的預設 `style_references` 直接依 `protocol` 校驗而非依使用者開關校驗，若角色、工作流槽位或上限超出 `protocol` 支援範圍會直接報錯，不靜默丟棄呼叫方引數。

## 發起圖像生成

```ts
imageGeneration.generate(
    requestOrPrompt: string | ImageGenerationRequest,
    options?: Partial<ImageGenerationRequest>,
): Promise<{
    imagePath: string;
    format: string;
    prompt: string;
    negativePrompt: string;
}>
```

### 請求參數

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `prompt` | `string` | 必填正向提示詞 |
| `negativePrompt` | `string` | 可選負向提示詞 |
| `aspectRatio` | `'1:1' \| '2:3' \| '3:2' \| '3:4' \| '4:3' \| '9:16' \| '16:9'` | 單次畫幅比例覆寫，自動映射至目標後端解析度或原生比例參數 |
| `width` / `height` | `number` | 顯式像素寬高覆寫 |
| `seed` | `number` | 隨機種子 |
| `loras` | `Array<{ name: string, weight?: number }>` | 標準 ComfyUI 工作流動態 LoRA 清單 |
| `references` | `ImageReferenceInput[]` | 受管本機參考圖陣列，依 `protocol` 校驗 |
| `characterPrompts` | `Array<{ prompt: string, negativePrompt?: string, center?: { x: number, y: number } }>` | 多角色獨立提示詞與歸一化座標，取值範圍 `0` 至 `1` |
| `attribution` | `'active_chat' \| 'none' \| { char_dir: string, chat_name: string, is_group: boolean }` | 控制寫入清理索引的聊天歸屬中繼資料；畫室草稿等跨聊天資產傳 `'none'` |
| `subdir` | `string` | `/user/images/` 下的輸出子目錄，例如 `'_studio'` |
| `includePresetStyleReferences` | `boolean` | 預設為 `true`；當目前預設開啟 `supportsStyleReference` 時自動合併預設綁定的畫風參考圖 |
| `skipPromptPrefix` | `boolean` | 為 `true` 時略過全域正向提示詞前綴拼接 |
| `signal` | `AbortSignal` | 中止訊號，觸發後立即取消進行中的生成請求 |

### 參考圖輸入範例

`references` 僅接受 `/user/images/`、`/characters/` 或 `/User Avatars/` 下的受管相對路徑：

```js
const result = await Luker.getContext().imageGeneration.generate({
    prompt: '1girl, rooftop observatory, starlight, brass astrolabe',
    aspectRatio: '3:4',
    references: [
        {
            imagePath: '/user/images/_references/char_alice_a1b2c3d4.png',
            role: 'character',
            name: 'Alice',
            fidelity: 0.8,
        },
        {
            imagePath: '/user/images/_style_references/watercolor.png',
            role: 'style',
            strength: 0.6,
        },
    ],
    attribution: 'active_chat',
});
```

伺服端媒體載入器直接拒絕外部 URL 與越界相對路徑。

## 生圖預設與 LoRA 目錄

```ts
imageGeneration.listPresets(): Array<{ id: string, name: string, source: string, model: string }>
imageGeneration.getCurrentPreset(): { id: string, name: string, config: object } | null
imageGeneration.switchPreset(idOrName: string): Promise<{ id: string, name: string }>
imageGeneration.getAvailableLoras(): Promise<{ names: string[], includeWeight: boolean }>
```

生圖預設綁定了連線設定後，若對應連線設定被刪除，`generate()` 會直接報錯提示重新綁定。

## 跨外掛圖片搜尋與網頁圖片擷取介面

需要聯網檢索視覺參考圖的擴充功能可透過 `getExtensionApi('search-tools')` 呼叫搜尋外掛能力：

```js
const searchApi = Luker.getContext().getExtensionApi('search-tools');
if (searchApi) {
    const capabilities = searchApi.getActiveProviderCapabilities();
    if (capabilities.supportsImageSearch) {
        const { results } = await searchApi.searchImages({
            query: '角色設定圖',
            max_results: 8,
        });
    }
    const { images } = await searchApi.extractPageImages({
        url: 'https://example.com/character-entry',
    });
}
```

## 相關頁面

- [圖像生成與 AI 插圖](/zh-TW/features/image-generation) —— 生圖後端、全域角色庫與工作台畫室使用說明
- [工作台 API](/zh-TW/development/extension-api/workbench) —— 嵌入式工作區與迭代目標註冊參考
- [外掛整合](/zh-TW/development/extension-api/plugin-integration) —— `registerExtensionApi` 與執行時正則註冊參考
