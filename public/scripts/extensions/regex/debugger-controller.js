// SPDX-License-Identifier: AGPL-3.0-or-later

export function createRegexDebuggerController({
    getThisChid,
    captureRegexTarget,
    renderExtensionTemplateAsync,
    getScriptsByType,
    getRuntimeRegexScripts,
    saveScriptsByType,
    updateScopedRegexScripts,
    saveSettingsNow,
    saveSettingsDebounced,
    loadRegexScripts,
    executeRegexScriptForDebugging,
    onReadonlyRegexViewOpenClick,
    onRegexEditorOpenClick,
    getRegexSortableDelay,
    messageFormatting,
    callGenericPopup,
    POPUP_TYPE,
    escapeHtml,
    uuidv4,
    t,
    SCRIPT_TYPES,
    SCRIPT_TYPE_UNKNOWN,
}) {
    function populateDebuggerRuleList(container, targets = {}) {
        const rulesContainer = container.find('#regex_debugger_rules');
        const ruleTemplate = container.find('#regex_debugger_rule_template');
        if (!rulesContainer.length || !ruleTemplate.length) {
            console.error('Regex Debugger: Could not find rule list or template in the DOM.');
            return;
        }

        rulesContainer.empty();

        const hasScopedTarget = Object.prototype.hasOwnProperty.call(targets, 'scopedTarget');
        const hasPresetTarget = Object.prototype.hasOwnProperty.call(targets, 'presetTarget');
        const scopedTarget = hasScopedTarget ? targets.scopedTarget : null;
        const presetTarget = hasPresetTarget ? targets.presetTarget : null;

        const globalScripts = getScriptsByType(SCRIPT_TYPES.GLOBAL).map((script, index) => {
            const scriptCopy = structuredClone(script);
            // @ts-ignore
            scriptCopy.type = SCRIPT_TYPES.GLOBAL;
            // @ts-ignore
            scriptCopy.__persistedId = script?.id ? String(script.id) : null;
            // @ts-ignore
            scriptCopy.__sourceIndex = index;
            return scriptCopy;
        });
        const presetScripts = (hasPresetTarget
            ? (presetTarget?.presetName ? getScriptsByType(SCRIPT_TYPES.PRESET, { target: presetTarget }) : [])
            : getScriptsByType(SCRIPT_TYPES.PRESET)
        ).map((script, index) => {
            const scriptCopy = structuredClone(script);
            // @ts-ignore
            scriptCopy.type = SCRIPT_TYPES.PRESET;
            // @ts-ignore
            scriptCopy.__persistedId = script?.id ? String(script.id) : null;
            // @ts-ignore
            scriptCopy.__sourceIndex = index;
            return scriptCopy;
        });
        const scopedScripts = (hasScopedTarget
            ? (scopedTarget?.character ? getScriptsByType(SCRIPT_TYPES.SCOPED, { target: scopedTarget }) : [])
            : getScriptsByType(SCRIPT_TYPES.SCOPED)
        ).map((script, index) => {
            const scriptCopy = structuredClone(script);
            // @ts-ignore
            scriptCopy.type = SCRIPT_TYPES.SCOPED;
            // @ts-ignore
            scriptCopy.__persistedId = script?.id ? String(script.id) : null;
            // @ts-ignore
            scriptCopy.__sourceIndex = index;
            return scriptCopy;
        });
        const pluginScripts = getRuntimeRegexScripts().map((script, index) => {
            const scriptCopy = structuredClone(script);
            // @ts-ignore
            scriptCopy.type = SCRIPT_TYPE_UNKNOWN;
            // @ts-ignore
            scriptCopy.__persistedId = script?.id ? String(script.id) : null;
            // @ts-ignore
            scriptCopy.__sourceIndex = index;
            return scriptCopy;
        });

        const allScripts = [...globalScripts, ...presetScripts, ...scopedScripts, ...pluginScripts];
        if (allScripts.length === 0) {
            rulesContainer.append('<div class="regex-debugger-no-rules">' + t`No regex rules found.` + '</div>');
            return;
        }

        container.data('allScripts', allScripts);

        const renderRule = (script) => {
            if (!script.id) script.id = uuidv4();
            const ruleElementContent = $(ruleTemplate.prop('content')).clone();
            const ruleElement = ruleElementContent.find('.regex-debugger-rule');

            ruleElement.attr('data-id', script.id);
            // @ts-ignore
            ruleElement.attr('data-persisted-id', script.__persistedId || '');
            // @ts-ignore
            ruleElement.attr('data-source-index', String(Number.isInteger(script.__sourceIndex) ? script.__sourceIndex : -1));
            // @ts-ignore
            ruleElement.find('.rule-name').text(script.scriptName);
            ruleElement.find('.rule-regex').text(script.findRegex);
            // @ts-ignore
            ruleElement
                .find('.rule-scope')
                .text(
                    {
                        [SCRIPT_TYPES.SCOPED]: t`Scoped`,
                        [SCRIPT_TYPES.GLOBAL]: t`Global`,
                        [SCRIPT_TYPES.PRESET]: t`Preset`,
                        [SCRIPT_TYPE_UNKNOWN]: t`Plugin`,
                    }[script.type],
                );
            ruleElement.find('.rule-enabled').prop('checked', !script.disabled);
            if (script.type === SCRIPT_TYPE_UNKNOWN) {
                const runtimeOwner = String(script.__runtime_owner || '').trim();
                const displayName = runtimeOwner ? `${script.scriptName} (${runtimeOwner})` : script.scriptName;
                ruleElement.find('.edit_rule').attr('title', String(t`Regex Editor`));
                ruleElement.find('.edit_rule i').removeClass('fa-pencil').addClass('fa-eye');
                ruleElement.find('.edit_rule').on('click', async () => {
                    await onReadonlyRegexViewOpenClick(script, displayName);
                });
            } else {
                // @ts-ignore
                ruleElement.find('.edit_rule').on('click', async () => {
                    // @ts-ignore
                    const existingPersistedId = script.__persistedId || false;
                    const prevDisabled = Boolean(script.disabled);
                    await onRegexEditorOpenClick(
                        existingPersistedId,
                        script.type,
                        // @ts-ignore
                        { existingIndex: existingPersistedId ? -1 : script.__sourceIndex },
                    );
                    const liveList = script.type === SCRIPT_TYPES.SCOPED
                        ? (hasScopedTarget ? (scopedTarget?.character ? getScriptsByType(SCRIPT_TYPES.SCOPED, { target: scopedTarget }) : []) : getScriptsByType(SCRIPT_TYPES.SCOPED))
                        : (script.type === SCRIPT_TYPES.PRESET
                            ? (hasPresetTarget ? (presetTarget?.presetName ? getScriptsByType(SCRIPT_TYPES.PRESET, { target: presetTarget }) : []) : getScriptsByType(SCRIPT_TYPES.PRESET))
                            : getScriptsByType(SCRIPT_TYPES.GLOBAL));
                    // @ts-ignore
                    const updated = existingPersistedId
                        ? liveList.find(s => s?.id === existingPersistedId)
                        // @ts-ignore
                        : liveList[script.__sourceIndex];
                    if (updated) {
                        const nextPersistedId = updated.id ? String(updated.id) : '';
                        // @ts-ignore
                        script.__persistedId = nextPersistedId || null;
                        ruleElement.attr('data-persisted-id', nextPersistedId);
                        ruleElement.find('.rule-name').text(updated.scriptName);
                        ruleElement.find('.rule-regex').text(updated.findRegex);
                        // Only sync the debugger-local checkbox when persisted disabled
                        // actually changed, so cancelling the editor preserves local toggles.
                        if (Boolean(updated.disabled) !== prevDisabled) {
                            ruleElement.find('.rule-enabled').prop('checked', !updated.disabled);
                        }
                        const domId = script.id;
                        const preservedType = script.type;
                        // @ts-ignore
                        const preservedIdx = script.__sourceIndex;
                        Object.assign(script, structuredClone(updated), {
                            id: domId,
                            type: preservedType,
                            __persistedId: nextPersistedId || null,
                            __sourceIndex: preservedIdx,
                        });
                    }
                });
            }

            ruleElement.on('click', function (event) {
                if ($(event.target).is('input, .menu_button, .menu_button i')) {
                    return;
                }
                const scriptId = $(this).data('id');
                const stepElement = $(`#step-result-${scriptId}`);
                const container = $('#regex_debugger_steps_output');

                if (stepElement.length && container.length) {
                    // Replace scrollIntoView with scrollTop animation
                    const targetTop = stepElement.position().top;
                    const containerScrollTop = container.scrollTop();
                    const containerHeight = container.height();

                    // Center the element if possible
                    let scrollTo = containerScrollTop + targetTop - (containerHeight / 2) + (stepElement.height() / 2);

                    container.animate({ scrollTop: scrollTo }, 300); // 300ms smooth scroll

                    stepElement.css('transition', 'background-color 0.5s').css('background-color', 'var(--highlight_color)');
                    setTimeout(() => stepElement.css('background-color', ''), 1000);
                }
            });

            return ruleElementContent;
        };

        if (globalScripts.length > 0) {
            rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Global Rules` + '</div>');
            const globalList = $('<ul id="regex_debugger_rules_global" class="sortable-list"></ul>');
            globalScripts.forEach(script => globalList.append(renderRule(script)));
            rulesContainer.append(globalList);
        }

        if (presetScripts.length > 0) {
            rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Preset Rules` + '</div>');
            const presetList = $('<ul id="regex_debugger_rules_preset" class="sortable-list"></ul>');
            presetScripts.forEach(script => presetList.append(renderRule(script)));
            rulesContainer.append(presetList);
        }

        if (scopedScripts.length > 0) {
            rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Scoped Rules` + '</div>');
            const scopedList = $('<ul id="regex_debugger_rules_scoped" class="sortable-list"></ul>');
            scopedScripts.forEach(script => scopedList.append(renderRule(script)));
            rulesContainer.append(scopedList);
        }

        if (pluginScripts.length > 0) {
            rulesContainer.append('<div class="list-header regex-debugger-list-header">' + t`Plugin Rules` + '</div>');
            const pluginList = $('<ul id="regex_debugger_rules_plugin" class="sortable-list"></ul>');
            pluginScripts.forEach(script => pluginList.append(renderRule(script)));
            rulesContainer.append(pluginList);
        }
    }

    /**
     * Opens the regex debugger.
     * @returns {Promise<void>}
     */
    async function onRegexDebuggerOpenClick() {
        let debuggerScopedTarget = getThisChid() !== undefined ? captureRegexTarget(SCRIPT_TYPES.SCOPED) : null;
        let debuggerPresetTarget = captureRegexTarget(SCRIPT_TYPES.PRESET);
        const templateContent = await renderExtensionTemplateAsync('regex', 'debugger');
        const debuggerHtml = $('<div>').html(templateContent);

        const stepTemplate = debuggerHtml.find('#regex_debugger_step_template');

        populateDebuggerRuleList(debuggerHtml, {
            scopedTarget: debuggerScopedTarget,
            presetTarget: debuggerPresetTarget,
        });

        // @ts-ignore
        debuggerHtml.find('#regex_debugger_rules_global').sortable({ delay: getRegexSortableDelay() }).disableSelection();
        // @ts-ignore
        debuggerHtml.find('#regex_debugger_rules_scoped').sortable({ delay: getRegexSortableDelay() }).disableSelection();
        // @ts-ignore
        debuggerHtml.find('#regex_debugger_rules_preset').sortable({ delay: getRegexSortableDelay() }).disableSelection();

        debuggerHtml.find('#regex_debugger_run_test').on('click', function () {
            const allScripts = debuggerHtml.data('allScripts');
            const orderedRuleIds = [
                ...$('#regex_debugger_rules_global').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
                ...$('#regex_debugger_rules_scoped').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
                ...$('#regex_debugger_rules_preset').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
                ...$('#regex_debugger_rules_plugin').find('li.regex-debugger-rule').map((i, el) => $(el).data('id')).get(),
            ];

            const rawInput = String($('#regex_debugger_raw_input').val());
            const stepsOutput = $('#regex_debugger_steps_output');
            const finalOutput = $('#regex_debugger_final_output');

            if (!stepsOutput.length || !finalOutput.length) return;

            const displayMode = $('input[name="display_mode"]:checked').val();
            stepsOutput.empty();
            finalOutput.empty();
            $('#regex_debugger_final_summary').remove();

            if (!allScripts) return;
            let textForNextStep = rawInput;
            let totalCharsCaptured = 0;
            let totalCharsAdded = 0;
            let totalCharsRemoved = 0;

            orderedRuleIds.forEach(scriptId => {
                const ruleElement = $(`#regex_debugger_rules [data-id="${scriptId}"]`);
                if (!ruleElement.find('.rule-enabled').is(':checked')) return;

                const script = allScripts.find(s => s.id === scriptId);

                if (script) {
                    const result = executeRegexScriptForDebugging(script, textForNextStep);
                    totalCharsCaptured += result.charsCaptured;
                    totalCharsAdded += result.charsAdded;
                    totalCharsRemoved += result.charsRemoved;

                    const stepElement = $(stepTemplate.prop('content')).clone();
                    // Set the ID on the TOP-LEVEL element that is being appended.
                    stepElement.find('>:first-child').attr('id', `step-result-${script.id}`);
                    const stepHeader = stepElement.find('.step-header');
                    stepHeader.find('strong').text(t`After:` + ` ${script.scriptName}`);

                    const metricsHtml = '<span class="step-metrics">' + t`Captured:` + ` ${result.charsCaptured}, ` + t`Added:` + ` +${result.charsAdded}, ` + t`Removed:` + ` -${result.charsRemoved}</span>`;
                    stepHeader.append(metricsHtml);

                    if (displayMode === 'highlight') {
                        stepElement.find('.step-output').html(result.highlightedOutput);
                    } else {
                        stepElement.find('.step-output').text(result.output);
                    }

                    if (result.error) {
                        stepHeader.append($(`<div class='warning_text text_rose-500'>${result.error}</div>`));
                    }

                    stepsOutput.append(stepElement);
                    textForNextStep = result.output;
                }
            });

            const summaryHtml = `
                <div id="regex_debugger_final_summary" class="regex-debugger-summary">
                    <strong>` + t`Total Captured:` + `</strong> ${totalCharsCaptured} | <strong>` + t`Total Added:` + `</strong> +${totalCharsAdded} | <strong>` + t`Total Removed:` + `</strong> -${totalCharsRemoved}
                </div>
            `;
            finalOutput.before(summaryHtml);

            const renderMode = $('#regex_debugger_render_mode').val();
            if (renderMode === 'message') {
                const formattedHtml = messageFormatting(textForNextStep, 'Debugger', true, false, null);
                const messageBlock = $('<div class="mes"><div class="mes_text"></div></div>');
                messageBlock.find('.mes_text').html(formattedHtml);
                finalOutput.append(messageBlock);
            } else {
                finalOutput.text(textForNextStep);
            }
        });

        debuggerHtml.find('#regex_debugger_save_order').on('click', async function () {
            const readOrderedRefs = (selector) => $(selector).children('li').map((_, el) => {
                const $el = $(el);
                const rawIndex = Number($el.attr('data-source-index'));
                return {
                    persistedId: String($el.attr('data-persisted-id') || ''),
                    sourceIndex: Number.isInteger(rawIndex) ? rawIndex : -1,
                };
            }).get();

            const mergeOrderedScripts = (orderedRefs, liveScripts) => {
                const byId = new Map();
                liveScripts.forEach((script, idx) => {
                    const key = String(script?.id || '');
                    if (key && !byId.has(key)) {
                        byId.set(key, idx);
                    }
                });
                const seenIndexes = new Set();
                const merged = [];
                for (const ref of orderedRefs) {
                    let matchedIdx = -1;
                    if (ref.persistedId && byId.has(ref.persistedId)) {
                        matchedIdx = byId.get(ref.persistedId);
                    } else if (!ref.persistedId
                        && ref.sourceIndex >= 0
                        && ref.sourceIndex < liveScripts.length
                        && !liveScripts[ref.sourceIndex]?.id) {
                        matchedIdx = ref.sourceIndex;
                    }
                    if (matchedIdx < 0 || seenIndexes.has(matchedIdx)) continue;
                    seenIndexes.add(matchedIdx);
                    merged.push(liveScripts[matchedIdx]);
                }
                liveScripts.forEach((script, idx) => {
                    if (!seenIndexes.has(idx)) {
                        merged.push(script);
                    }
                });
                return merged;
            };

            const globalRefs = readOrderedRefs('#regex_debugger_rules_global');
            const scopedRefs = readOrderedRefs('#regex_debugger_rules_scoped');
            const presetRefs = readOrderedRefs('#regex_debugger_rules_preset');

            const newGlobalScripts = mergeOrderedScripts(globalRefs, getScriptsByType(SCRIPT_TYPES.GLOBAL));
            const newPresetScripts = debuggerPresetTarget?.presetName
                ? mergeOrderedScripts(presetRefs, getScriptsByType(SCRIPT_TYPES.PRESET, { target: debuggerPresetTarget }))
                : [];

            let failed = false;
            let succeeded = false;
            let globalSavedImmediately = false;

            if ($('#regex_debugger_rules_global').length) {
                try {
                    await saveScriptsByType(newGlobalScripts, SCRIPT_TYPES.GLOBAL, {
                        persistGlobal: () => saveSettingsNow(),
                    });
                    succeeded = true;
                    globalSavedImmediately = true;
                } catch (error) {
                    failed = true;
                    console.error('[Regex] Failed to save global regex order from debugger', error);
                }
            }
            if (debuggerScopedTarget?.character && $('#regex_debugger_rules_scoped').length) {
                try {
                    await updateScopedRegexScripts(
                        currentScripts => mergeOrderedScripts(scopedRefs, currentScripts),
                        debuggerScopedTarget,
                    );
                    succeeded = true;
                } catch (error) {
                    failed = true;
                    console.error('[Regex] Failed to save scoped regex order from debugger', error);
                }
            }
            if (debuggerPresetTarget?.presetName && $('#regex_debugger_rules_preset').length) {
                try {
                    await saveScriptsByType(newPresetScripts, SCRIPT_TYPES.PRESET, { target: debuggerPresetTarget });
                    succeeded = true;
                } catch (error) {
                    failed = true;
                    console.error('[Regex] Failed to save preset regex order from debugger', error);
                }
            }

            if (succeeded && !globalSavedImmediately) {
                saveSettingsDebounced();
            }
            await loadRegexScripts();
            if (failed) {
                toastr.error(succeeded ? t`Some regex script changes could not be saved.` : t`Could not save regex script order.`);
            } else {
                toastr.success(t`Regex script order saved!`);
            }

            const currentPopupContent = $('div:has(> #regex_debugger_rules)');
            debuggerScopedTarget = getThisChid() !== undefined ? captureRegexTarget(SCRIPT_TYPES.SCOPED) : null;
            debuggerPresetTarget = captureRegexTarget(SCRIPT_TYPES.PRESET);
            populateDebuggerRuleList(currentPopupContent, {
                scopedTarget: debuggerScopedTarget,
                presetTarget: debuggerPresetTarget,
            });
            // @ts-ignore
            currentPopupContent.find('#regex_debugger_rules_global').sortable({ delay: getRegexSortableDelay() }).disableSelection();
            // @ts-ignore
            currentPopupContent.find('#regex_debugger_rules_scoped').sortable({ delay: getRegexSortableDelay() }).disableSelection();
            // @ts-ignore
            currentPopupContent.find('#regex_debugger_rules_preset').sortable({ delay: getRegexSortableDelay() }).disableSelection();
        });

        debuggerHtml.find('#regex_debugger_expand_steps').on('click', function () {
            const popupContainer = $('<div class="expanded-regex-container"></div>');
            const navPanel = $('<div class="expanded-regex-nav"><h4>Steps</h4></div>');
            const contentPanel = $('<div class="expanded-regex-content"></div>');

            const content = $('#regex_debugger_steps_output').clone().html();
            contentPanel.html(content);

            $('#regex_debugger_rules .regex-debugger-rule').each(function () {
                const ruleElement = $(this);
                const scriptId = ruleElement.data('id');
                const scriptName = ruleElement.find('.rule-name').text();

                const link = $(`<a href="#">${escapeHtml(scriptName)}</a>`);
                link.data('target-id', `step-result-${scriptId}`);

                link.on('click', function (e) {
                    e.preventDefault();
                    navPanel.find('a').removeClass('active');
                    $(this).addClass('active');

                    const targetId = $(this).data('target-id');
                    // The selector is now correct for the structure.
                    const targetElement = contentPanel.find(`#${targetId}`);

                    if (targetElement.length) {
                        const scrollTo = contentPanel.scrollTop() + targetElement.position().top;
                        contentPanel.animate({ scrollTop: scrollTo }, 300);

                        targetElement.css('transition', 'background-color 0.5s').css('background-color', 'var(--highlight_color)');
                        setTimeout(() => targetElement.css('background-color', ''), 1000);
                    }
                });

                navPanel.append(link);
            });

            popupContainer.append(navPanel).append(contentPanel);
            callGenericPopup(popupContainer, POPUP_TYPE.TEXT, t`Step-by-step Transformation`, { wide: true, allowVerticalScrolling: false });
        });

        debuggerHtml.find('#regex_debugger_expand_final').on('click', function () {
            const content = $('#regex_debugger_final_output').html();
            const popupContent = $('<div class="regex-popup-content"></div>').html(content);
            callGenericPopup(popupContent, POPUP_TYPE.TEXT, t`Final Output`, { wide: true, large: true, allowVerticalScrolling: true });
        });

        await callGenericPopup(debuggerHtml.children(), POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    }


    return {
        populateDebuggerRuleList,
        onRegexDebuggerOpenClick,
    };
}
