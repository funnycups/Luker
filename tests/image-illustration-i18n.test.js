import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const zhCn = JSON.parse(readFileSync(new URL('../public/locales/zh-cn.json', import.meta.url), 'utf8'));
const zhTw = JSON.parse(readFileSync(new URL('../public/locales/zh-tw.json', import.meta.url), 'utf8'));

const EXPECTED_KEYS = [
    'sd_illustration_api_preset',
    'sd_illustration_auto_generate',
    'sd_illustration_context_count',
    'sd_illustration_display_width',
    'sd_illustration_enabled',
    'sd_illustration_generate_last',
    'sd_illustration_llm_preset',
    'sd_illustration_max_concurrent',
    'sd_illustration_message_button',
    'sd_illustration_min_interval',
    'sd_illustration_open_studio',
    'sd_illustration_preset',
    'sd_illustration_preset_delete',
    'sd_illustration_preset_new',
    'sd_illustration_preset_rename',
    'sd_illustration_prompt',
    'sd_illustration_studio_prompt',
    'sd_illustration_title',
    'Also delete server image files',
    'Copy of ${0}',
    'Copy prompt',
    'Could not delete server image files',
    'Delete session',
    'Delete this illustration?',
    'Delete this prompt preset?',
    'Describe an image to start.',
    'Describe the image or give feedback',
    'Edit prompt',
    'Generated',
    'Illustration failed',
    'Image generation failed for ${0} prompt(s).',
    'Image prompt',
    'Memory recall is unavailable',
    'Natural language style',
    'No assistant message to illustrate.',
    'No illustration preset is selected.',
    'No image selected.',
    'No images yet.',
    'Preset name',
    'Prompt copied.',
    'Skipped image prompts',
    'Some illustrations were appended because their anchors were not found.',
    'Studio request failed',
    'Tag style',
    'The illustration prompt is empty.',
    'The image prompt is empty.',
    'The studio prompt is empty.',
    'Zoom',
];

test('all illustration keys exist in both Chinese locales', () => {
    for (const key of EXPECTED_KEYS) {
        expect(zhCn[key]).toBeTruthy();
        expect(zhTw[key]).toBeTruthy();
    }
});
