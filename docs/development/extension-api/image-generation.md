# Image Generation API

`context.imageGeneration` exposes Luker's structured image generation runtime across all three API layers, covering backend capability inspection, preset management, reference image routing, multi-character positional prompts, and chat attribution control.

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

`ImageCapabilities` describes what the active backend and model accept:

| Field | Type | Description |
| --- | --- | --- |
| `source` | `string` | Active image backend identifier, such as `'google'`, `'chat_image'`, `'openai'`, `'openrouter'`, `'xai'`, `'novel'`, `'comfy'`, `'auto'`, or `'vlad'` |
| `model` | `string` | Active image model identifier |
| `supportsCharacterReference` | `boolean` | Whether `role: 'character'` reference images are accepted |
| `maxCharacterReferences` | `number \| null` | Maximum character reference count per request, or `null` when unbounded by protocol |
| `supportsStyleReference` | `boolean` | Whether `role: 'style'` reference images are accepted |
| `maxStyleReferences` | `number \| null` | Maximum style reference count per request, or `null` when unbounded by protocol |
| `supportsSourceImage` | `boolean` | Whether `role: 'source'` image editing is accepted |
| `supportsMultiCharacterPrompts` | `boolean` | Whether `characterPrompts` positional character partitions are accepted |
| `supportsDynamicAspectRatio` | `boolean` | Whether per-request `aspectRatio` overrides are accepted |
| `availableLoras` | `{ names: string[], includeWeight: boolean }` | Dynamic LoRA catalog exposed by the active ComfyUI workflow |

Passing reference roles or counts that exceed `getCapabilities()` throws an actionable error instead of dropping unsupported inputs.

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
| `references` | `ImageReferenceInput[]` | Managed local reference images |
| `characterPrompts` | `Array<{ prompt: string, negativePrompt?: string, center?: { x: number, y: number } }>` | Multi-character prompt partitions with normalized coordinates from `0` to `1` |
| `attribution` | `'active_chat' \| 'none' \| { char_dir: string, chat_name: string, is_group: boolean }` | Controls chat ownership metadata recorded for Data Maid cleanup. Pass `'none'` for chat-independent assets such as Studio drafts |
| `subdir` | `string` | Optional output subdirectory under `/user/images/`, such as `'_studio'` |
| `includePresetStyleReferences` | `boolean` | Defaults to `true`; merges preset `style_references` when the active backend supports style references |
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
