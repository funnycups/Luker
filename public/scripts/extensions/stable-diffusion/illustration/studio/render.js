import { t } from '../../../../i18n.js';
import { renderMessageMarkdown } from '../../../../iteration-library/render.js';
import { escapeHtml } from '../message.js';

function roleLabel(role) {
    if (role === 'user') {
        return t`You`;
    }
    if (role === 'assistant') {
        return t`Assistant`;
    }
    return t`System`;
}

function parseToolArguments(raw) {
    try {
        const parsed = JSON.parse(String(raw || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function renderToolCards(message) {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
        return '';
    }
    const results = new Map((Array.isArray(message?.tool_results) ? message.tool_results : [])
        .map(result => [String(result.tool_call_id || ''), String(result.content || '')]));
    return calls.map(call => {
        const name = String(call?.function?.name || '');
        const args = parseToolArguments(call?.function?.arguments);
        const prompt = String(args?.prompt || '');
        const result = results.get(String(call?.id || '')) || '';
        let status = '';
        try {
            const parsed = JSON.parse(result);
            status = parsed?.status === 'failed' ? t`Failed` : (parsed?.status === 'ready' ? t`Generated` : '');
        } catch {
            status = '';
        }
        return `<div class="sd_studio_tool_card" data-studio-tool-name="${escapeHtml(name)}">
            <div class="sd_studio_tool_name">${escapeHtml(name)}${status ? ` <span class="sd_studio_tool_status">${escapeHtml(status)}</span>` : ''}</div>
            <div class="sd_studio_tool_prompt">${escapeHtml(prompt)}</div>
        </div>`;
    }).join('');
}

function renderMessages(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    if (messages.length === 0) {
        return `<div class="sd_studio_empty">${escapeHtml(t`Describe an image to start.`)}</div>`;
    }
    return messages.map(message => {
        const role = String(message?.role || 'user');
        const content = String(message?.content || '').trim();
        return `<div class="sd_studio_message sd_studio_message_${escapeHtml(role)}" data-studio-message-id="${escapeHtml(message?.id || '')}">
            <div class="sd_studio_message_role">${escapeHtml(roleLabel(role))}</div>
            ${content ? `<div class="sd_studio_message_text">${renderMessageMarkdown(content)}</div>` : ''}
            ${role === 'assistant' ? renderToolCards(message) : ''}
        </div>`;
    }).join('');
}

function renderImages(session, selectedImageId) {
    const images = Array.isArray(session?.images) ? session.images : [];
    if (images.length === 0) {
        return `<div class="sd_studio_empty">${escapeHtml(t`No images yet.`)}</div>`;
    }
    return images.map(image => {
        const id = String(image?.id || '');
        const selected = id === String(selectedImageId || '');
        const failed = image?.status === 'failed';
        const media = failed
            ? `<div class="sd_studio_image_failed" title="${escapeHtml(image?.error || '')}">${escapeHtml(t`Image generation failed`)}</div>`
            : `<img class="sd_studio_image_thumb" src="${escapeHtml(image?.imageUrl || '')}" alt="${escapeHtml(image?.prompt || '')}" />`;
        return `<div class="sd_studio_image${selected ? ' selected' : ''}${failed ? ' failed' : ''}" data-studio-image-id="${escapeHtml(id)}">
            ${media}
            <div class="sd_studio_image_prompt">${escapeHtml(image?.prompt || '')}</div>
            <div class="sd_studio_image_actions">
                <div class="menu_button" data-studio-action="zoom" title="${escapeHtml(t`Zoom`)}"><i class="fa-solid fa-magnifying-glass-plus"></i></div>
                <div class="menu_button" data-studio-action="copy" title="${escapeHtml(t`Copy prompt`)}"><i class="fa-solid fa-copy"></i></div>
                <div class="menu_button" data-studio-action="regenerate" title="${escapeHtml(t`Regenerate`)}"><i class="fa-solid fa-rotate"></i></div>
            </div>
        </div>`;
    }).join('');
}

export function renderStudio(session, root, { selectedImageId = '' } = {}) {
    const $root = $(root);
    $root.find('#sd_studio_messages').html(renderMessages(session));
    $root.find('#sd_studio_images').html(renderImages(session, selectedImageId));
    const messages = $root.find('#sd_studio_messages')[0];
    if (messages) {
        messages.scrollTop = messages.scrollHeight;
    }
}

export function renderStudioPreview(image, root) {
    const $root = $(root);
    const $preview = $root.find('#sd_studio_preview');
    if (!image || image.status === 'failed') {
        $preview.html(`<div class="sd_studio_empty">${escapeHtml(t`No image selected.`)}</div>`);
        return;
    }
    $preview.html(`<img src="${escapeHtml(image.imageUrl)}" alt="${escapeHtml(image.prompt)}" />`);
}
