# Image Generation API

`context.imageGeneration` exposes Luker's structured image generation runtime across all three API layers, covering user-controlled reference switches alongside backend protocol inspection, preset management, reference image routing, multi-character positional prompts, and chat attribution control.

## Three-Layer API Exposure

```js
// Layer 1 — direct ESM import (core modules)
import { imageGenerationApi } from '/scripts/image-generation/registry.js';

// Layer 2 — lukerContext / Luker.getContext() / extension API registry
const imageGen = Luker.getContext().imageGeneration;
const sdApi = Luker.getContext().getExtensionApi('sd');

// Layer 3 — CardApp sandbox context
const cardImageGen = ctx.imageGeneration;
```

CardApp `ctx.imageGeneration.generate` defaults `attribution` to `'active_chat'` unless explicitly overridden with `attribution: 'none'`.

## Availability and Capability Inspection

```ts
imageGeneration.isAvailable(): boolean
imageGeneration.getCapabilities(): Promise<ImageCapabilities>
```

`ImageCapabilities` exposes the active preset's user-controlled reference switches together with underlying backend `protocol` capabilities and configuration conflict `warnings`:

| Field | Type | Description |
| --- | --- | --- |
| `source` | `string` | Active image backend identifier, such as `'google'`, `'chat_image'`, `'openai'`, `'openrouter'`, `'xai'`, `'novel'`, `'comfy'`, `'auto'`, or `'vlad'` |
| `model` | `string` | Active image model identifier |
| `characterReferenceEnabled` | `boolean` | Whether character archive usage is enabled on the active generation preset |
| `characterReferenceMode` | `'text_only' \| 'image_only' \| 'text_and_image'` | Character reference delivery mode configured on the active generation preset |
| `supportsCharacterTextReference` | `boolean` | `true` when `characterReferenceEnabled` is `true` and `characterReferenceMode` is `'text_only'` or `'text_and_image'` |
| `supportsCharacterReference` | `boolean` | User-enabled capability: `true` when `characterReferenceEnabled` is `true` and `characterReferenceMode` is `'image_only'` or `'text_and_image'` |
| `maxCharacterReferences` | `number \| null` | User-facing per-request character image budget (`0` when `supportsCharacterReference` is `false`; otherwise derived from `protocol.maxCharacterReferences` and reduced by active enabled style references when `protocol.sharedReferenceSlots` is `true`), or `null` when unbounded |
| `supportsStyleReference` | `boolean` | User-enabled capability: whether preset style & vibe references are enabled on the active generation preset |
| `maxStyleReferences` | `number \| null` | `0` when `supportsStyleReference` is `false`; otherwise `protocol.maxStyleReferences` |
| `supportsSourceImage` | `boolean` | User-enabled capability: whether img2img source image editing is enabled on the active generation preset |
| `supportsMultiCharacterPrompts` | `boolean` | Mirrors `protocol.supportsMultiCharacterPrompts`: whether `characterPrompts` positional character partitions are accepted |
| `supportsDynamicAspectRatio` | `boolean` | Mirrors `protocol.supportsDynamicAspectRatio`: whether per-request `aspectRatio` overrides are accepted |
| `availableLoras` | `{ names: string[], includeWeight: boolean }` | Dynamic LoRA catalog exposed by the active ComfyUI workflow |
| `protocol` | `ProtocolCapabilities` | Underlying backend and workflow protocol support independent of user preset switches (`supportsCharacterReference`, `maxCharacterReferences`, `supportsStyleReference`, `maxStyleReferences`, `supportsSourceImage`, `supportsMultiCharacterPrompts`, `supportsDynamicAspectRatio`, `sharedReferenceSlots`, `maxTotalReferences`, `comfyReferenceSlotCount`, `comfyWorkflowError`) |
| `warnings` | `Array<{ code: string, message: string, affects: Array<'character_image' \| 'style' \| 'source'> }>` | Configuration conflicts where enabled user reference switches contradict backend `protocol` support or ComfyUI workflow `%ref_image%` slots |

Top-level `supportsCharacterReference`, `supportsStyleReference`, and `supportsSourceImage` reflect the active preset's user-controlled switches consumed by AI agents and UI entry points, while `protocol.supports*` reports what the active backend, model, and ComfyUI workflow actually accept. Explicit `generate({ references })` calls validate passed `references` together with any merged preset `style_references` against `protocol` rather than user switches, throwing an actionable error when a role, workflow slot, or `protocol` limit is exceeded instead of silently dropping inputs.

## Generating Images

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

### Request Fields

| Field | Type | Description |
| --- | --- | --- |
| `prompt` | `string` | Required positive image prompt |
| `negativePrompt` | `string` | Optional negative prompt |
| `aspectRatio` | `'1:1' \| '2:3' \| '3:2' \| '3:4' \| '4:3' \| '9:16' \| '16:9'` | Per-request aspect ratio override mapped to backend dimensions or native aspect parameter |
| `width` / `height` | `number` | Explicit pixel dimension overrides |
| `seed` | `number` | Optional generation seed |
| `loras` | `Array<{ name: string, weight?: number }>` | Dynamic LoRA selections for standard ComfyUI workflows |
| `references` | `ImageReferenceInput[]` | Managed local reference images validated against `protocol` |
| `characterPrompts` | `Array<{ prompt: string, negativePrompt?: string, center?: { x: number, y: number } }>` | Multi-character prompt partitions with normalized coordinates from `0` to `1` |
| `attribution` | `'active_chat' \| 'none' \| { char_dir: string, chat_name: string, is_group: boolean }` | Controls chat ownership metadata recorded for Data Maid cleanup. Pass `'none'` for chat-independent assets such as Studio drafts |
| `subdir` | `string` | Optional output subdirectory under `/user/images/`, such as `'_studio'` |
| `includePresetStyleReferences` | `boolean` | Defaults to `true`; merges preset `style_references` when `supportsStyleReference` is enabled on the active preset |
| `skipPromptPrefix` | `boolean` | Skips global style prefix composition when `true` |
| `signal` | `AbortSignal` | Cancels the in-flight generation request when aborted |

### Reference Image Entries

Each item in `references` accepts managed server-relative paths under `/user/images/`, `/characters/`, or `/User Avatars/`:

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

Remote URLs and path traversal segments are rejected by the server media loader.

## Presets and LoRAs

```ts
imageGeneration.listPresets(): Array<{ id: string, name: string, source: string, model: string }>
imageGeneration.getCurrentPreset(): { id: string, name: string, config: object } | null
imageGeneration.switchPreset(idOrName: string): Promise<{ id: string, name: string }>
imageGeneration.getAvailableLoras(): Promise<{ names: string[], includeWeight: boolean }>
```

When a generation preset binds a Connection Profile via `connection_profile`, deleting that Connection Profile causes `generate()` to throw an explicit error until the preset is rebound.

## Cross-Extension Image Search Service

Plugins that look up visual references online can consume the `search-tools` extension API without importing search internals:

```js
const searchApi = Luker.getContext().getExtensionApi('search-tools');
if (searchApi) {
    const capabilities = searchApi.getActiveProviderCapabilities();
    if (capabilities.supportsImageSearch) {
        const { results } = await searchApi.searchImages({
            query: 'character reference sheet',
            max_results: 8,
        });
    }
    const { images } = await searchApi.extractPageImages({
        url: 'https://example.com/character-entry',
    });
}
```

## Related Pages

- [Image Generation & AI Illustration](/features/image-generation) — user guide for backends, character archive, and Workbench Studio
- [Workbench API](/development/extension-api/workbench) — embedded workspace and iteration target registration
- [Plugin Integration](/development/extension-api/plugin-integration) — `registerExtensionApi` and runtime regex providers
