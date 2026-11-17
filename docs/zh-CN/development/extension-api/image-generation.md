# 图像生成 API

`context.imageGeneration` 按三层一致性暴露 Luker 结构化图像生成能力，涵盖后端能力探测、生图预设切换、参考图多协议路由、多角色分区提示词以及图像归属控制。

## 三层 API 暴露

```js
// Layer 1 —— 核心模块直接 ESM 导入
import { imageGenerationApi } from '/scripts/image-generation/registry.js';

// Layer 2 —— lukerContext / Luker.getContext() / 扩展 API 注册表
const imageGen = Luker.getContext().imageGeneration;
const sdApi = Luker.getContext().getExtensionApi('sd');

// Layer 3 —— CardApp 沙箱上下文
const cardImageGen = ctx.imageGeneration;
```

CardApp 内的 `ctx.imageGeneration.generate` 默认将 `attribution` 设为 `'active_chat'`；生成独立于当前聊天的资产时可显式传入 `attribution: 'none'`。

## 可用性与后端能力探测

```ts
imageGeneration.isAvailable(): boolean
imageGeneration.getCapabilities(): Promise<ImageCapabilities>
```

`ImageCapabilities` 描述当前生图后端与模型支持的结构化能力：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | `string` | 当前生图源标识，例如 `'google'`、`'chat_image'`、`'openai'`、`'openrouter'`、`'xai'`、`'novel'`、`'comfy'`、`'auto'` 或 `'vlad'` |
| `model` | `string` | 当前生图模型标识 |
| `supportsCharacterReference` | `boolean` | 是否支持传入 `role: 'character'` 角色参考图 |
| `maxCharacterReferences` | `number \| null` | 单次请求支持的角色参考图上限；协议无固定上限时为 `null` |
| `supportsStyleReference` | `boolean` | 是否支持传入 `role: 'style'` 画风参考图 |
| `maxStyleReferences` | `number \| null` | 单次请求支持的画风参考图上限；协议无固定上限时为 `null` |
| `supportsSourceImage` | `boolean` | 是否支持传入 `role: 'source'` 底图执行图像修改 |
| `supportsMultiCharacterPrompts` | `boolean` | 是否支持 `characterPrompts` 多角色分区提示词与坐标 |
| `supportsDynamicAspectRatio` | `boolean` | 是否支持按次覆盖 `aspectRatio` 画幅比例 |
| `availableLoras` | `{ names: string[], includeWeight: boolean }` | 当前 ComfyUI 工作流暴露的动态 LoRA 列表 |

传入超出 `getCapabilities()` 支持范围的参考图角色或数量时，`generate()` 会直接报错，不静默丢弃调用方参数。

## 发起图像生成

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

### 请求参数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | `string` | 必填正向提示词 |
| `negativePrompt` | `string` | 可选负向提示词 |
| `aspectRatio` | `'1:1' \| '2:3' \| '3:2' \| '3:4' \| '4:3' \| '9:16' \| '16:9'` | 单次画幅比例覆盖，自动映射至目标后端分辨率或原生比例参数 |
| `width` / `height` | `number` | 显式像素宽高覆盖 |
| `seed` | `number` | 随机种子 |
| `loras` | `Array<{ name: string, weight?: number }>` | 标准 ComfyUI 工作流动态 LoRA 列表 |
| `references` | `ImageReferenceInput[]` | 受管本地参考图数组 |
| `characterPrompts` | `Array<{ prompt: string, negativePrompt?: string, center?: { x: number, y: number } }>` | 多角色独立提示词与归一化坐标，取值范围 `0` 至 `1` |
| `attribution` | `'active_chat' \| 'none' \| { char_dir: string, chat_name: string, is_group: boolean }` | 控制写入清理索引的聊天归属元数据；画室草稿等跨聊天资产传 `'none'` |
| `subdir` | `string` | `/user/images/` 下的输出子目录，例如 `'_studio'` |
| `includePresetStyleReferences` | `boolean` | 默认为 `true`；后端支持画风参考时自动合并当前生图预设绑定的画风参考图 |
| `skipPromptPrefix` | `boolean` | 为 `true` 时跳过全局正向提示词前缀拼接 |
| `signal` | `AbortSignal` | 中止信号，触发后立即取消进行中的生成请求 |

### 参考图输入示例

`references` 仅接受 `/user/images/`、`/characters/` 或 `/User Avatars/` 下的受管相对路径：

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

服务端媒体加载器直接拒绝外部 URL 与越界相对路径。

## 生图预设与 LoRA 目录

```ts
imageGeneration.listPresets(): Array<{ id: string, name: string, source: string, model: string }>
imageGeneration.getCurrentPreset(): { id: string, name: string, config: object } | null
imageGeneration.switchPreset(idOrName: string): Promise<{ id: string, name: string }>
imageGeneration.getAvailableLoras(): Promise<{ names: string[], includeWeight: boolean }>
```

生图预设绑定了连接配置后，若对应连接配置被删除，`generate()` 会直接报错提示重新绑定。

## 跨插件图片搜索与网页图片提取接口

需要联网检索视觉参考图的扩展可通过 `getExtensionApi('search-tools')` 调用搜索插件能力：

```js
const searchApi = Luker.getContext().getExtensionApi('search-tools');
if (searchApi) {
    const capabilities = searchApi.getActiveProviderCapabilities();
    if (capabilities.supportsImageSearch) {
        const { results } = await searchApi.searchImages({
            query: '角色设定图',
            max_results: 8,
        });
    }
    const { images } = await searchApi.extractPageImages({
        url: 'https://example.com/character-entry',
    });
}
```

## 相关页面

- [图像生成与 AI 插图](/zh-CN/features/image-generation) —— 生图后端、全局角色库与工作台画室使用说明
- [工作台 API](/zh-CN/development/extension-api/workbench) —— 嵌入式工作区与迭代目标注册参考
- [插件集成](/zh-CN/development/extension-api/plugin-integration) —— `registerExtensionApi` 与运行时正则注册参考
