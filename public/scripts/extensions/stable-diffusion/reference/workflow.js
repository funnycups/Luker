// SPDX-License-Identifier: AGPL-3.0-or-later

export const REF_IMAGE_SINGLE_PLACEHOLDER = '%ref_image%';

const NUMBERED_REF_IMAGE_RE = /^%ref_image_(\d+)%$/;

const LATENT_SAMPLER_CLASSES = new Set([
    'KSampler',
    'KSamplerAdvanced',
    'SamplerCustom',
    'SamplerCustomAdvanced',
]);

const TERMINAL_OUTPUT_CLASSES = new Set([
    'SaveImage',
    'PreviewImage',
    'SaveAnimatedWEBP',
    'SaveAnimatedPNG',
]);

const SINGLE_INPUT_TRANSFORM_CLASSES = new Set([
    'VAEEncode',
    'VAEEncodeForInpaint',
    'CLIPVisionEncode',
    'PrepImageForClipVision',
    'ImageScale',
    'ImageScaleBy',
    'ImageScaleToTotalPixels',
    'FluxKontextImageScale',
    'ImageInvert',
    'ImagePadForOutpaint',
]);

const DUAL_IMAGE_MERGE_CLASSES = new Set([
    'ImageStitch',
    'ImageBatch',
    'ImageCompositeMasked',
]);

function createRefError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isLink(value) {
    return Array.isArray(value)
        && value.length === 2
        && typeof value[0] === 'string'
        && Number.isInteger(value[1]);
}

function parseSlotPlaceholder(rawValue) {
    if (typeof rawValue !== 'string') {
        return null;
    }
    const trimmed = rawValue.trim();
    if (trimmed === REF_IMAGE_SINGLE_PLACEHOLDER) {
        return 1;
    }
    const match = NUMBERED_REF_IMAGE_RE.exec(trimmed);
    if (!match) {
        return null;
    }
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1) {
        return null;
    }
    return index;
}

function normalizeWorkflowObject(workflowInput) {
    if (typeof workflowInput === 'string') {
        const sanitized = workflowInput.replace(/"%(?!ref_image)[a-zA-Z0-9_]+%"/g, '"__placeholder__"');
        return JSON.parse(sanitized);
    }
    if (!workflowInput || typeof workflowInput !== 'object' || Array.isArray(workflowInput)) {
        throw createRefError('ref_template_invalid_workflow', 'ComfyUI workflow must be a JSON object keyed by node id.');
    }
    return workflowInput;
}

/**
 * Inspects a ComfyUI API-format workflow for LoadImage reference template slots
 * (`"%ref_image%"` or `"%ref_image_1%"`..`"%ref_image_N%"`).
 *
 * @param {object | string} workflowInput
 * @returns {{ slotCount: number, slots: number[], maxSlot: number, nodesBySlot: Array<{ slot: number, nodeId: string }> }}
 */
export function inspectReferenceSlots(workflowInput) {
    const workflow = normalizeWorkflowObject(workflowInput);
    const seenSlots = new Map();

    for (const [nodeId, node] of Object.entries(workflow)) {
        if (node?.class_type !== 'LoadImage') {
            continue;
        }
        const slot = parseSlotPlaceholder(node?.inputs?.image);
        if (slot === null) {
            continue;
        }
        if (seenSlots.has(slot)) {
            const prevId = seenSlots.get(slot);
            throw createRefError(
                'ref_template_duplicate_slot',
                `Workflow defines duplicate ComfyUI reference slot #${slot} on LoadImage nodes '${prevId}' and '${nodeId}'.`,
            );
        }
        seenSlots.set(slot, nodeId);
    }

    const entries = [...seenSlots.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([slot, nodeId]) => ({ slot, nodeId }));
    const slots = entries.map(e => e.slot);

    return {
        slotCount: slots.length,
        slots,
        maxSlot: slots.length > 0 ? slots[slots.length - 1] : 0,
        nodesBySlot: entries,
    };
}

function rewireNodeOutputReferences(workflow, fromNodeId, resolveReplacement) {
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node?.inputs || typeof node.inputs !== 'object') {
            continue;
        }
        for (const [inputName, value] of Object.entries(node.inputs)) {
            if (isLink(value) && value[0] === fromNodeId) {
                const replacement = resolveReplacement(value[1], nodeId, inputName);
                node.inputs[inputName] = [replacement[0], replacement[1]];
            }
        }
    }
}

function findConsumers(workflow, targetNodeId) {
    const consumers = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node?.inputs || typeof node.inputs !== 'object') {
            continue;
        }
        for (const [inputName, value] of Object.entries(node.inputs)) {
            if (isLink(value) && value[0] === targetNodeId) {
                consumers.push({
                    consumerId: nodeId,
                    inputName,
                    outputIndex: value[1],
                });
            }
        }
    }
    return consumers;
}

function resolvePassThroughTrunkLink(consumer, deadInputName) {
    const cls = String(consumer?.class_type || '');
    const inputs = consumer?.inputs || {};

    if (cls === 'ReferenceLatent' && deadInputName === 'latent' && isLink(inputs.conditioning)) {
        return () => inputs.conditioning;
    }

    if ((/IPAdapter|InstantID|Pulid/i.test(cls)) && deadInputName !== 'model' && isLink(inputs.model)) {
        return () => inputs.model;
    }

    if (cls === 'ControlNetApply' && deadInputName === 'image' && isLink(inputs.conditioning)) {
        return () => inputs.conditioning;
    }

    if (cls === 'ControlNetApplyAdvanced' && deadInputName === 'image' && isLink(inputs.positive) && isLink(inputs.negative)) {
        return (outputIndex) => (outputIndex === 1 ? inputs.negative : inputs.positive);
    }

    if (DUAL_IMAGE_MERGE_CLASSES.has(cls)) {
        const survivingLinks = Object.entries(inputs)
            .filter(([key, val]) => key !== deadInputName && isLink(val))
            .map(([, val]) => val);
        if (survivingLinks.length === 1) {
            return () => survivingLinks[0];
        }
    }

    return null;
}

function pruneDeadBranch(workflow, deadNodeId, slotNumber) {
    const consumers = findConsumers(workflow, deadNodeId);
    delete workflow[deadNodeId];

    for (const { consumerId, inputName } of consumers) {
        const consumer = workflow[consumerId];
        if (!consumer) {
            continue;
        }
        const cls = String(consumer.class_type || '');

        if (
            (LATENT_SAMPLER_CLASSES.has(cls) && (inputName === 'latent_image' || inputName === 'samples'))
            || (TERMINAL_OUTPUT_CLASSES.has(cls) && inputName === 'images')
        ) {
            throw createRefError(
                'ref_template_required_slot_missing',
                `ComfyUI workflow requires reference image slot #${slotNumber} as the primary latent/image source on '${cls}' node '${consumerId}', and no reference image was provided.`,
            );
        }

        const passThroughResolver = resolvePassThroughTrunkLink(consumer, inputName);
        if (passThroughResolver) {
            rewireNodeOutputReferences(workflow, consumerId, (outputIndex) => passThroughResolver(outputIndex));
            delete workflow[consumerId];
            continue;
        }

        if (DUAL_IMAGE_MERGE_CLASSES.has(cls)) {
            const otherLinks = Object.entries(consumer.inputs || {})
                .filter(([k, v]) => k !== inputName && isLink(v));
            if (otherLinks.length === 0) {
                pruneDeadBranch(workflow, consumerId, slotNumber);
                continue;
            }
        }

        if (
            SINGLE_INPUT_TRANSFORM_CLASSES.has(cls)
            || inputName === 'pixels'
            || (inputName === 'image' && !isLink(consumer.inputs?.model) && !isLink(consumer.inputs?.conditioning))
        ) {
            pruneDeadBranch(workflow, consumerId, slotNumber);
            continue;
        }

        delete consumer.inputs[inputName];
    }
}

/**
 * Applies uploaded ComfyUI filenames to LoadImage `%ref_image%` / `%ref_image_N%` template nodes
 * and prunes unused optional reference branches cleanly.
 *
 * @param {object} workflow Parsed ComfyUI API workflow object
 * @param {string[]} [uploadedFilenames=[]] Remote ComfyUI filenames in slot order
 * @returns {object} Transformed deep copy of the workflow
 */
export function applyReferencesToWorkflow(workflow, uploadedFilenames = []) {
    const result = JSON.parse(JSON.stringify(workflow));
    const files = Array.isArray(uploadedFilenames) ? uploadedFilenames.filter(f => typeof f === 'string' && f.trim()) : [];
    const info = inspectReferenceSlots(result);

    if (info.slotCount === 0) {
        if (files.length > 0) {
            throw createRefError(
                'ref_template_missing',
                `ComfyUI workflow has no %ref_image% LoadImage template node, while ${files.length} reference image(s) were supplied.`,
            );
        }
        return result;
    }

    if (files.length > info.slotCount) {
        throw createRefError(
            'ref_template_insufficient_slots',
            `ComfyUI workflow defines ${info.slotCount} reference slot(s), fewer than the ${files.length} reference image(s) supplied.`,
        );
    }

    info.nodesBySlot.forEach(({ slot, nodeId }, orderedIdx) => {
        const assignedFile = files[orderedIdx];
        if (assignedFile) {
            result[nodeId].inputs.image = assignedFile;
        } else {
            pruneDeadBranch(result, nodeId, slot);
        }
    });

    return result;
}
