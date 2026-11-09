import { renderExtensionTemplateAsync } from '../../../extensions.js';

export function setIllustrationEnabled(enabled) {
    const value = Boolean(enabled);
    $('body').toggleClass('illustration-enabled', value);
    $('#sd_illustration_generate_last, #sd_illustration_open_studio').toggle(value);
}

export async function initMenus({ settings, onGenerateLast, onGenerateMessage, onOpenStudio }) {
    const html = await renderExtensionTemplateAsync('stable-diffusion', 'illustration-menu');
    $('#extensionsMenu').append(html);

    if (typeof onGenerateLast === 'function') {
        $('#sd_illustration_generate_last').on('click', onGenerateLast);
    }
    if (typeof onOpenStudio === 'function') {
        $('#sd_illustration_open_studio').on('click', onOpenStudio);
    }
    if (typeof onGenerateMessage === 'function') {
        $('#chat').on('click', '.sd_illustration_gen', function () {
            const messageId = Number($(this).closest('.mes').attr('mesid'));
            if (Number.isInteger(messageId) && messageId >= 0) {
                onGenerateMessage(messageId);
            }
        });
    }

    setIllustrationEnabled(settings.enabled);
}
