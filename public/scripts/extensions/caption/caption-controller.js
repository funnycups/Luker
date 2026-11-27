// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure controller for captioning workflows, activity-guard leases, and file picker flows.
 */
export function createCaptionController({
    getSettings,
    getContext,
    isTrueBoolean,
    ensureImageFormatSupported,
    getBase64Async,
    getFileExtension,
    saveBase64AsFile,
    isVideoCaptioningAvailable,
    doCaptionRequest,
    wrapCaptionTemplate,
    sendCaptionedMessage,
    setSpinnerIcon,
    setImageIcon,
    MEDIA_TYPE,
    t,
    getDocument = () => globalThis.document,
    getToastr = () => globalThis.toastr,
    fetchImpl = (...args) => globalThis.fetch(...args),
}) {
    async function withCaptionActivity(fn) {
        const guard = getContext()?.activityGuard;
        if (typeof guard?.run !== 'function') {
            return await fn();
        }
        return await guard.run({
            source: 'caption:run',
            label: t`Image captioning`,
            scope: 'chat',
        }, fn);
    }

    async function getCaptionForFile(file, prompt, quiet) {
        try {
            if (file.type.startsWith('video/') && !isVideoCaptioningAvailable()) {
                throw new Error('Video captioning is not available for the current source.');
            }

            setSpinnerIcon();
            const context = getContext();
            const fileData = await getBase64Async(await ensureImageFormatSupported(file));
            const extension = getFileExtension(file);
            const base64Data = fileData.split(',')[1];
            const { caption } = await doCaptionRequest(base64Data, fileData, prompt);
            if (!quiet) {
                const imagePath = await saveBase64AsFile(base64Data, context.name2, '', extension);
                await sendCaptionedMessage(caption, imagePath, file.type);
            }
            return caption;
        } catch (error) {
            const errorMessage = error.message || 'Unknown error';
            getToastr()?.error(errorMessage, 'Failed to caption');
            console.error(error);
            return '';
        } finally {
            setImageIcon();
        }
    }

    async function onSelectImage(e, prompt, quiet) {
        if (!(e.target instanceof HTMLInputElement)) {
            return '';
        }

        const file = e.target.files[0];
        const form = e.target.form;

        if (!file || !(file instanceof File)) {
            form && form.reset();
            return '';
        }

        const caption = await getCaptionForFile(file, prompt, quiet);
        form && form.reset();
        return caption;
    }

    async function captionExistingMessage(message, mediaIndex) {
        if (!Array.isArray(message?.extra?.media) || message.extra.media.length === 0) {
            return;
        }

        if (mediaIndex === undefined || isNaN(mediaIndex) || mediaIndex < 0 || mediaIndex >= message.extra.media.length) {
            mediaIndex = 0;
        }

        const mediaAttachment = message.extra.media[mediaIndex];

        if (!mediaAttachment || !mediaAttachment.url || mediaAttachment.type === MEDIA_TYPE.AUDIO) {
            return;
        }

        if (mediaAttachment.type === MEDIA_TYPE.VIDEO && !isVideoCaptioningAvailable()) {
            throw new Error('Captioning videos is not supported for the current source.');
        }

        await withCaptionActivity(async () => {
            const imageData = await fetchImpl(mediaAttachment.url);
            const blob = await imageData.blob();
            const fileName = mediaAttachment.url.split('/').pop().split('?')[0] || 'image.jpg';
            const file = new File([blob], fileName, { type: blob.type });
            const caption = await getCaptionForFile(file, null, true);

            if (!caption) {
                console.warn('Failed to generate a caption for the image.');
                return;
            }

            const wrappedCaption = await wrapCaptionTemplate(caption);
            const messageText = String(message.mes).trim();

            if (!messageText) {
                message.extra.inline_image = false;
                message.mes = wrappedCaption;
                mediaAttachment.title = wrappedCaption;
                mediaAttachment.captioned = true;
            } else {
                message.extra.inline_image = true;
                mediaAttachment.append_title = true;
                mediaAttachment.title = wrappedCaption;
                mediaAttachment.captioned = true;
            }
        });
    }

    async function captionCommandCallback(args, prompt) {
        const quiet = isTrueBoolean(args?.quiet);
        const messageId = args?.mesId ?? args?.id;
        const index = Number(args?.index ?? 0);

        if (!isNaN(Number(messageId))) {
            const message = getContext().chat[messageId];
            if (Array.isArray(message?.extra?.media) && message.extra.media.length > 0) {
                const mediaAttachment = message.extra.media[index] || message.extra.media[0];
                if (!mediaAttachment || !mediaAttachment.url) {
                    getToastr()?.error('The specified message does not contain an image.');
                    return '';
                }
                if (mediaAttachment.type === MEDIA_TYPE.AUDIO) {
                    getToastr()?.error('The specified media is an audio file. Captioning audio files is not supported.');
                    return '';
                }
                if (mediaAttachment.type === MEDIA_TYPE.VIDEO && !isVideoCaptioningAvailable()) {
                    getToastr()?.error('The specified media is a video. Captioning videos is not supported for the current source.');
                    return '';
                }
                return await withCaptionActivity(async () => {
                    try {
                        const fetchResult = await fetchImpl(mediaAttachment.url);
                        const blob = await fetchResult.blob();
                        const fileName = mediaAttachment.url.split('/').pop().split('?')[0] || 'image.jpg';
                        const file = new File([blob], fileName, { type: blob.type });
                        return await getCaptionForFile(file, prompt, quiet);
                    } catch (error) {
                        getToastr()?.error('Failed to get image from the message. Make sure the image is accessible.');
                        return '';
                    }
                });
            }
        }

        const doc = getDocument();
        return new Promise(resolve => {
            const input = doc.createElement('input');
            input.type = 'file';
            input.accept = 'image/*,video/*';
            input.onchange = async (e) => {
                let caption = '';
                try {
                    caption = await withCaptionActivity(() => onSelectImage(e, prompt, quiet));
                } catch (error) {
                    console.error(error);
                } finally {
                    resolve(caption);
                }
            };
            input.oncancel = () => resolve('');
            input.click();
        });
    }

    function handleWandFileChange(e) {
        return withCaptionActivity(() => onSelectImage(e, '', false));
    }

    return {
        withCaptionActivity,
        getCaptionForFile,
        onSelectImage,
        captionExistingMessage,
        captionCommandCallback,
        handleWandFileChange,
        getSettings,
    };
}
