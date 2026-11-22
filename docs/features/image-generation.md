# Image Generation & AI Illustration

Luker's built-in **Image Generation** extension connects local and cloud image backends, cross-backend character and style reference images, dual-agent **AI Illustration** for chat messages, a global **Character Archive**, and an interactive **Image Studio** inside [Workbench](/features/workbench).

## Connection Profiles and Backends

Open **Extensions → Image Generation** to select a **Generation preset** and **Source**.

- **Connection profile binding** — **Google AI**, **OpenAI**, **OpenRouter**, **xAI (Grok)**, **Z.AI**, **NanoGPT**, **Chutes**, **Electron Hub**, **AI/ML API**, **Pollinations**, and **OpenAI-compatible Chat Multimodal** can bind an existing **Connection profile** to reuse its endpoint URL, API key, and proxy configuration, or use a dedicated **API Key** set directly in the panel.
- **Explicit binding validation** — When a bound **Connection profile** is deleted, generation requests report an actionable error until you select a valid profile or switch back to a direct key.
- **Generation presets** — Each **Generation preset** stores its backend source, model, resolution, sampling parameters, connection binding, and style references for one-click switching.

## Reference Images and Style Transfer

Under **Style & Vibe References**, click **Add style reference** to attach style reference images or `.naiv4vibe` files to the active **Generation preset**. Character reference images from the **Character Archive** and source images from **Edit from this image** are routed automatically according to the active backend:

| Backend | Supported Reference Capabilities |
| --- | --- |
| **Google AI** Gemini image models | Character references, style references, source image editing, and dynamic aspect ratios |
| **OpenAI-compatible Chat Multimodal** & **OpenRouter** | Multimodal character, style, and source image inputs |
| **OpenAI** & **xAI (Grok)** | Multipart image editing with reference images on edit-capable models |
| **NovelAI Diffusion** | V4.5 character references with fidelity control, V3 and V4 vibe transfer with `.naiv4vibe` import, and V4 multi-character prompt partitions |
| **ComfyUI** | Automatic image upload into `%ref_image%` and numbered `%ref_image_1%` workflow placeholders, with unused reference branches pruned automatically |
| **Stable Diffusion Web UI** & **SD.Next** | Source image editing through image-to-image |

## AI Illustration

Expand **AI Illustration** inside **Extensions → Image Generation** and enable **Enable AI illustration**. Check **Illustrate assistant messages automatically** to illustrate new replies automatically, or trigger illustration manually via **Illustrate the last message** in the wand menu or **AI Illustration** in a message's action menu.

### Character Consistency and Exploration

When illustrating a message, the illustration agent coordinates character visuals in three ways:

- **Well-known fanwork characters** — When a character is already recognized natively by the active image generation model, the illustration agent generates the prompt directly without launching web exploration.
- **Unarchived fanwork characters** — When the scene introduces a public-work character whose appearance is unfamiliar to the image model, the illustration agent invokes the **Character profile agent** to read the character card, bound world books, public character databases, and [Search Tools](/features/search-tools) image results, then archives verified tags, outfits, and reference images into the global **Character Archive**. Enable **Send downloaded reference previews to multimodal LLM for inspection** inside **Character profile agent** when your exploration model supports vision.
- **Archived characters** — Characters already present in the **Character Archive** reuse their stored canonical tags, outfit presets, and reference images immediately.

Inline illustrations are stripped from outgoing chat prompts automatically while remaining visible in plugin floor context so subsequent illustrations stay consistent.

### Inline Illustration Actions

Click any inline illustration in chat to open its action bar:

- **Regenerate** or **Edit prompt** to create a new version in the illustration's history tree.
- **Edit from this image** to enter an **Edit instruction** and pass the current image as a source reference on backends that support source image editing.
- **Lock illustration** / **Unlock illustration** to protect specific inline images when re-illustrating the entire message.
- **Use this version** in the version history list to switch the displayed inline image to any previous version in one click.

## Workbench Workspace

Click **Open in Workbench** in **Extensions → Image Generation**, select **Image Studio** in the wand menu, or switch to the **Image Generation** tab inside [Workbench](/features/workbench):

- **Image Studio** — Conversational workspace for free image generation and source image editing, with visual review, session branching with **Branch from here**, single-image gallery regeneration, and persistent history across restarts.
- **Character Archive** — Global library of character appearance tags, outfits, and local reference sheets:
  - **AI Profile Builder** / **Refine with AI** — Opens a two-pane conversational dialog to create or update a character profile across multiple turns. Choose an explicit **Source material** option when you want the builder to read a specific character card or your user persona, or keep **Do not read a character card** selected. The builder can search public art databases, download candidate portraits, generate candidate reference sheets, and stage partial updates into the live editable draft on the right without overwriting concurrent manual edits. Click **Confirm & save to archive** to promote retained candidate images into formal archive references with **Change history** undo support; cancelling discards temporary images cleanly.
  - **Manual editing** — Click **New character profile** to author tags, prose descriptions, outfits, and uploaded local reference images directly.
- **Run Traces** — Inspect live and recent illustration and exploration runs, export run JSON, or click **Diagnose with AI** to troubleshoot failed runs in Workbench **AI iteration**.

## Iterating ComfyUI Workflows with AI

When **Source** is set to **ComfyUI**, click **Iterate workflow with AI** next to the **ComfyUI Workflow** selector, or open [Workbench](/features/workbench) **AI iteration** and select **Image Generation**:

- **Live node introspection** — The iteration AI queries your connected ComfyUI server on demand to inspect installed custom node classes, required and optional inputs, available model and LoRA filenames, and output slot indices.
- **Template node wiring and tuning** — Ask the AI to clone an API-format workflow, insert a dynamic `%lora_name%` `LoraLoader` template, wire `%ref_image%` or numbered `%ref_image_1%` reference slots to installed conditioning nodes, or adjust sampling, upscaling, and custom `%placeholder%` bindings.
- **Draft test generation and rollback** — The AI executes draft workflows directly against your ComfyUI server to verify links and render a preview image in the review pane before anything is saved. Review per-node changes in the **Change list** to apply, and revert any applied workflow edit from **Change history**.

## Simulating Prompts in Workbench

Open [Workbench](/features/workbench) **AI iteration** and select **Image Generation** to test unsaved illustration or character profile prompt edits in an isolated sandbox before applying them:

- **Illustration and profile simulation** — The iteration AI runs the illustration agent, background character exploration, or conversational character profile building against the working draft and opens **Simulation Review** with rendered image previews, full prompts, and tool traces.
- **Annotations and re-run loop** — Enable **Annotation mode** to highlight passages and add inline comments, or click **Re-run simulation** to run a fresh attempt from the original input snapshot. Clicking **Submit** sends the text trace and annotations back to the iteration AI, and closing the review cleans up temporary images automatically.

## Related Pages

- [Workbench](/features/workbench) — unified workspace, AI iteration, Q&A, and Change history
- [Search Tools](/features/search-tools) — web and image search backends used during fanwork character exploration
- [Image Generation API](/development/extension-api/image-generation) — three-layer developer API for plugins and CardApps
