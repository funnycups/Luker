export const LORA_NAME_PLACEHOLDER = '%lora_name%';
export const LORA_MODEL_STRENGTH_PLACEHOLDER = '%lora_strength_model%';
export const LORA_CLIP_STRENGTH_PLACEHOLDER = '%lora_strength_clip%';

const LORA_LINK_INPUTS = new Map([
    ['LoraLoader', ['model', 'clip']],
    ['LoraLoaderModelOnly', ['model']],
]);

function createLoraError(code, message) {
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

function findTemplateNodeId(workflow) {
    const nodeIds = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (node?.inputs?.lora_name === LORA_NAME_PLACEHOLDER) {
            nodeIds.push(nodeId);
        }
    }
    if (nodeIds.length === 0) {
        return null;
    }
    if (nodeIds.length > 1) {
        const listed = nodeIds.map(nodeId => `'${nodeId}'`).join(', ');
        throw createLoraError('lora_template_multiple', `Workflow contains multiple LoRA template nodes: ${listed}`);
    }
    return nodeIds[0];
}

function linkInputNames(nodeId, node) {
    const names = LORA_LINK_INPUTS.get(node.class_type);
    if (!names) {
        throw createLoraError(
            'lora_template_unmappable',
            `LoRA template node '${nodeId}' has an unsupported class type: ${String(node.class_type)}`,
        );
    }
    return names;
}

function assertLinkInput(nodeId, node, name) {
    if (!isLink(node.inputs[name])) {
        throw createLoraError(
            'lora_template_unmappable',
            `LoRA template node '${nodeId}' input '${name}' is not a [string, integer] link`,
        );
    }
}

/**
 * Locates the LoRA template node in a workflow graph and reports which strength
 * fields carry placeholders.
 *
 * @param {object} workflow Parsed workflow graph keyed by node id.
 * @returns {{ nodeId: string, hasModelStrength: boolean, hasClipStrength: boolean } | null}
 */
export function inspectLoraTemplate(workflow) {
    const nodeId = findTemplateNodeId(workflow);
    if (nodeId === null) {
        return null;
    }
    const node = workflow[nodeId];
    for (const name of linkInputNames(nodeId, node)) {
        assertLinkInput(nodeId, node, name);
    }
    return {
        nodeId,
        hasModelStrength: node.inputs.strength_model === LORA_MODEL_STRENGTH_PLACEHOLDER,
        hasClipStrength: node.inputs.strength_clip === LORA_CLIP_STRENGTH_PLACEHOLDER,
    };
}

function maxNumericNodeId(workflow) {
    let max = 0;
    for (const nodeId of Object.keys(workflow)) {
        const numericId = Number(nodeId);
        if (Number.isInteger(numericId) && numericId > max) {
            max = numericId;
        }
    }
    return max;
}

function linkForOutput(linkInputs, outputIndex, templateId, nodeId, inputName) {
    const link = linkInputs[outputIndex];
    if (!link) {
        throw createLoraError(
            'lora_template_unmappable',
            `Node '${nodeId}' input '${inputName}' references output ${outputIndex} of LoRA template node '${templateId}', which has no matching link input`,
        );
    }
    return link;
}

function rewireTemplateOutputs(workflow, templateId, resolveLink) {
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node || typeof node.inputs !== 'object' || node.inputs === null) {
            throw createLoraError(
                'lora_template_unmappable',
                `Workflow node '${nodeId}' has no inputs object`,
            );
        }
        for (const [inputName, value] of Object.entries(node.inputs)) {
            if (!Array.isArray(value) || value[0] !== templateId) {
                continue;
            }
            if (!isLink(value)) {
                throw createLoraError(
                    'lora_template_unmappable',
                    `Node '${nodeId}' input '${inputName}' holds a malformed reference to LoRA template node '${templateId}': ${JSON.stringify(value)}`,
                );
            }
            node.inputs[inputName] = resolveLink(value[1], nodeId, inputName);
        }
    }
}

/**
 * Expands the LoRA template node into one concrete node per selected LoRA,
 * chained in selection order, and returns a deep copy of the workflow.
 *
 * @param {object} workflow Parsed workflow graph keyed by node id.
 * @param {Array<{ name: string, weight: number }>} loras Selected LoRAs in application order.
 * @returns {object} Expanded workflow graph.
 */
export function applyLorasToWorkflow(workflow, loras) {
    const result = structuredClone(workflow);
    const template = inspectLoraTemplate(result);
    if (!template) {
        if (loras.length > 0) {
            throw createLoraError(
                'lora_template_missing',
                `Workflow has no LoRA template node but ${loras.length} LoRA selection(s) were supplied`,
            );
        }
        return result;
    }

    const templateId = template.nodeId;
    const templateNode = result[templateId];
    const linkNames = LORA_LINK_INPUTS.get(templateNode.class_type);
    const sourceLinks = linkNames.map(name => templateNode.inputs[name]);

    if (loras.length === 0) {
        delete result[templateId];
        rewireTemplateOutputs(result, templateId, (outputIndex, nodeId, inputName) => [
            ...linkForOutput(sourceLinks, outputIndex, templateId, nodeId, inputName),
        ]);
        return result;
    }

    const firstNewId = maxNumericNodeId(result) + 1;
    const newIds = loras.map((_, index) => String(firstNewId + index));
    const lastNewId = newIds[newIds.length - 1];

    delete result[templateId];
    rewireTemplateOutputs(result, templateId, (outputIndex, nodeId, inputName) => {
        linkForOutput(sourceLinks, outputIndex, templateId, nodeId, inputName);
        return [lastNewId, outputIndex];
    });

    loras.forEach((lora, index) => {
        const inputs = { ...templateNode.inputs };
        inputs.lora_name = lora.name;
        if (inputs.strength_model === LORA_MODEL_STRENGTH_PLACEHOLDER) {
            inputs.strength_model = lora.weight;
        }
        if (inputs.strength_clip === LORA_CLIP_STRENGTH_PLACEHOLDER) {
            inputs.strength_clip = lora.weight;
        }
        linkNames.forEach((name, linkIndex) => {
            inputs[name] = index === 0 ? [...sourceLinks[linkIndex]] : [newIds[index - 1], linkIndex];
        });
        result[newIds[index]] = { ...templateNode, inputs };
    });

    return result;
}
