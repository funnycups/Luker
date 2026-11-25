# Image Generation & AI Illustration

Luker's built-in **Image Generation** extension connects local and cloud image backends, cross-backend character and style reference images, dual-agent **AI Illustration** for chat messages, a global **Character Archive**, and an interactive **Image Studio** inside [Workbench](/features/workbench).

## Connection Profiles and Backends

Open **Extensions → Image Generation** to select a **Generation preset** and **Source**.

- **Connection profile binding** — **Google AI**, **OpenAI**, **OpenRouter**, **xAI (Grok)**, **Z.AI**, **NanoGPT**, **Chutes**, **Electron Hub**, **AI/ML API**, **Pollinations**, and **OpenAI-compatible Chat Multimodal** can bind an existing **Connection profile** to reuse its endpoint URL, API key, and proxy configuration, or use a dedicated **API Key** set directly in the panel.
- **Explicit binding validation** — When a bound **Connection profile** is deleted, generation requests report an actionable error until you select a valid profile or switch back to a direct key.
- **Generation presets** — Each **Generation preset** stores its backend source, model, resolution, sampling parameters, connection binding, reference and img2img switches, and style references for one-click switching.

## References & Img2Img

Under **References & Img2Img**, each **Generation preset** stores explicit switches that control how character profiles, style references, and source image editing are used by AI agents and UI actions:

- **Enable character references** — Enables the global **Character Archive** for **AI Illustration** and **Image Studio**. When enabled, **Delivery mode** selects how archived character entries are supplied:
  - **Text description only** — Incorporates archived plain-text visual descriptions and Danbooru character tags into prompts without attaching character reference images.
  - **Reference images only** — Attaches archived reference images without expanding archived appearance descriptions into prompts.
  - **Text description and reference images** — Supplies both archived plain-text descriptions and labeled reference images.
- **Allow img2img editing (edit based on an existing image)** — Enables **Edit from this image** on inline chat illustrations and **Edit source** in **Image Studio**.
- **Enable style & vibe references** — Controls whether attached style reference images or `.naiv4vibe` files are merged into generation requests. Click **Add style reference** to attach a file and enable the toggle automatically; turning the toggle off retains the saved list in a dimmed state without sending it.

A live warning area below **References & Img2Img** reports configuration conflicts immediately whenever active switches contradict the selected **Source**, **Model**, or **ComfyUI Workflow**, such as enabling reference images or img2img on a ComfyUI workflow without `%ref_image%` slots, selecting a backend or model without image inputs, exceeding NovelAI's style reference limit, or filling all shared reference slots with style references. When regenerating an inline illustration, editing its prompt, or regenerating a gallery image in **Image Studio**, previously saved reference images whose role is turned off on the active preset are skipped with a notice.

Explicit reference inputs passed through `/imagine` or the developer API validate directly against the active backend protocol and workflow capabilities:

| Backend | Supported Reference Protocol |
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

When **Enable character references** is turned on, the illustration agent coordinates character visuals according to character familiarity and archive state:

- **Well-known fanwork characters** — When a character is already recognized natively by the active image generation model, the illustration agent writes the prompt directly without launching web exploration.
- **Unarchived fanwork characters** — When the scene introduces a public-work character whose appearance is unfamiliar to the active image model, the illustration agent invokes the **Character profile agent** to read public character databases, [Search Tools](/features/search-tools) image results, and any supplied source material, then archives a structured plain-text description, a Danbooru character name tag when one exists, and labeled reference images into the global **Character Archive**. Enable **Allow the profile agent to visually inspect candidate reference images** inside **Character profile agent** when the profile agent model supports vision.
- **Archived characters** — Characters already present in the **Character Archive** supply their stored plain-text description and/or labeled reference images according to the active **Delivery mode**.

When **Enable character references** is turned off, **AI Illustration** writes prompts from the conversation, character card, and world book context without accessing the **Character Archive**.

Inline illustrations are stripped from outgoing chat prompts automatically while remaining visible in plugin floor context so subsequent illustrations stay consistent.

### Inline Illustration Actions

Click any inline illustration in chat to open its action bar:

- **Regenerate** or **Edit prompt** to create a new version in the illustration's history tree.
- **Edit from this image** to enter an **Edit instruction** and pass the current image as a source reference when **Allow img2img editing (edit based on an existing image)** is enabled on supported backends.
- **Lock illustration** / **Unlock illustration** to protect specific inline images when re-illustrating the entire message.
- **Use this version** in the version history list to switch the displayed inline image to any previous version in one click.

## Workbench Workspace

Click **Open in Workbench** in **Extensions → Image Generation**, select **Image Studio** in the wand menu, or switch to the **Image Generation** tab inside [Workbench](/features/workbench):

- **Image Studio** — Conversational workspace for free image generation and source image editing, with visual review, session branching with **Branch from here**, single-image gallery regeneration, **Edit source** when img2img editing is enabled, and persistent history across restarts.
- **Character Archive** — Global library of plain-text character descriptions and labeled local reference images, where each profile stores **Canonical display name**, **Aliases**, **Source work or franchise**, **Character visual description**, and a **Reference images** grid with optional **Reference label** notes:
  - **AI Profile Builder** / **Refine with AI** — Opens a two-pane conversational dialog to create or update a character profile across multiple turns. Choose an explicit **Source material** option when you want the builder to read a specific character card or your user persona, or keep **Do not read a character card** selected. The builder can search public art databases, look up a Danbooru character name tag, download candidate portraits, generate candidate reference sheets, and stage partial updates to **Character visual description** and labeled **Reference images** in the live editable draft on the right without overwriting concurrent manual edits. Click **Confirm & save to archive** to promote retained candidate images into formal archive references with **Change history** undo support; cancelling discards temporary images cleanly.
  - **Manual editing** — Click **New character profile** to author plain-text **Character visual description** entries and attach labeled local images via **Upload local reference image**.
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
