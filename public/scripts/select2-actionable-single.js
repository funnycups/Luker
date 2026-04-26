import { t } from './i18n.js';

let actionableSingleSelectCounter = 0;

/** @type {Map<string, Set<string>>} ownerKey -> collapsed group IDs (session-only) */
const collapsedGroupsMap = new Map();

function buildOwnerKey(selectElement) {
    const baseId = String(selectElement?.id || 'select')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'select';
    actionableSingleSelectCounter += 1;
    return `luker-action-select-${baseId}-${actionableSingleSelectCounter}`;
}

function getOptionData(option, selectElement, ownerKey) {
    const value = String(option?.id ?? '');
    const text = String(option?.text ?? '').trim();
    const element = option?.element instanceof HTMLOptionElement ? option.element : null;

    return {
        ownerKey,
        value,
        text,
        element,
        selectElement,
    };
}

function isDeleteButtonTarget(target, ownerKey) {
    if (!(target instanceof Element)) {
        return false;
    }

    const button = target.closest('.luker-action-select2-option__delete');
    return button instanceof HTMLElement && button.dataset.lukerActionOwner === ownerKey;
}

function isGroupMenuButtonTarget(target, ownerKey) {
    if (!(target instanceof Element)) {
        return false;
    }

    const button = target.closest('.luker-action-select2-option__group');
    return button instanceof HTMLElement && button.dataset.lukerActionOwner === ownerKey;
}

function isGroupHeaderTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return !!target.closest('.luker-preset-group-header');
}

function isGroupActionTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return !!target.closest('.luker-preset-group-action, .luker-preset-group-subgroup');
}

/**
 * Applies collapsed state to the select2 dropdown.
 * Hides/shows group member LIs based on collapsed groups.
 * @param {HTMLSelectElement} selectElement
 * @param {Set<string>} collapsedGroups
 */
function applyCollapsedState(selectElement, collapsedGroups) {
    const $dropdown = $(selectElement).data('select2')?.$dropdown;
    if (!$dropdown?.length) return;

    // Build a map of groupId -> whether any ancestor is collapsed
    const options = selectElement.options;
    const groupIds = new Set();
    for (const opt of options) {
        if (opt.dataset.presetGroupHeader === 'true') {
            groupIds.add(opt.dataset.presetGroupId);
        }
    }

    // Helper: check if a group or any of its ancestor groups is collapsed
    const isAncestorCollapsed = (groupId) => {
        let currentId = groupId;
        while (currentId) {
            if (collapsedGroups.has(currentId)) return true;
            // Find parent of currentId
            const currentOpt = Array.from(options).find(o => o.dataset.presetGroupHeader === 'true' && o.dataset.presetGroupId === currentId);
            const parentId = currentOpt?.dataset?.presetGroupParentId || null;
            currentId = parentId;
        }
        return false;
    };

    $dropdown.find('.select2-results__option').each(function () {
        const $li = $(this);
        const $content = $li.children().first();

        // Group member
        if ($content.hasClass('luker-preset-group-member')) {
            const groupId = $content.attr('data-preset-group-id');
            // Hide if own group is collapsed OR any ancestor is collapsed
            if (groupId && isAncestorCollapsed(groupId)) {
                $li.addClass('luker-preset-group-member--hidden');
            } else {
                $li.removeClass('luker-preset-group-member--hidden');
            }
        }

        // Group header
        if ($content.hasClass('luker-preset-group-header')) {
            const groupId = $content.attr('data-preset-group-id');
            const $chevron = $content.find('.luker-preset-group-chevron');
            if (groupId && collapsedGroups.has(groupId)) {
                $chevron.removeClass('luker-preset-group-chevron--expanded');
            } else {
                $chevron.addClass('luker-preset-group-chevron--expanded');
            }

            // Hide sub-group headers if any ancestor is collapsed (but not self)
            const parentId = $content.attr('data-preset-group-parent-id');
            if (parentId && isAncestorCollapsed(parentId)) {
                $li.addClass('luker-preset-group-member--hidden');
            } else {
                $li.removeClass('luker-preset-group-member--hidden');
            }
        }
    });
}

/**
 * Re-renders an already-open Select2 dropdown after options are rebuilt.
 * @param {HTMLSelectElement} selectElement
 */
function refreshOpenDropdown(selectElement) {
    const $select = $(selectElement);
    const isOpen = $select.next('.select2-container').hasClass('select2-container--open');
    if (isOpen) {
        $select.select2('close');
        $select.select2('open');
    } else {
        $select.select2('open');
    }
}

/**
 * Dismisses any open preset context menu.
 */
function dismissContextMenu() {
    $('.luker-preset-ctx-menu').remove();
}

/**
 * Shows a context menu for a preset option.
 * @param {MouseEvent|{x:number,y:number}} anchor
 * @param {string} presetName
 * @param {object} callbacks
 * @param {HTMLSelectElement} selectElement
 * @param {string} ownerKey
 */
function showPresetContextMenu(anchor, presetName, callbacks, selectElement, ownerKey) {
    dismissContextMenu();
    if (!callbacks) return;

    const groups = callbacks.getGroups();
    const currentGroup = callbacks.getGroupForPreset(presetName);

    const $menu = $('<div class="luker-preset-ctx-menu"></div>');

    // "New Group..." option
    const $newGroup = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--new"></div>')
        .html('<i class="fa-solid fa-folder-plus"></i> ' + t`New Preset Group...`)
        .on('click', async (e) => {
            e.stopPropagation();
            dismissContextMenu();
            const name = prompt(t`Preset group name:`);
            if (!name?.trim()) return;
            const groupId = await callbacks.createGroup(name.trim(), currentGroup?.id);
            if (groupId) {
                await callbacks.addToGroup(presetName, groupId);
            }
            refreshOpenDropdown(selectElement);
        });
    $menu.append($newGroup);

    // Existing groups
    if (groups.length > 0) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');

        if (currentGroup) {
            const $current = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--label"></div>')
                .text(`${t`Current group`}: ${currentGroup.name}`);
            $menu.append($current);
        } else {
            const $current = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--label"></div>')
                .text(t`Current group: Ungrouped`);
            $menu.append($current);
        }

        for (const group of groups) {
            const isActive = currentGroup?.id === group.id;
            const depth = callbacks.getGroupDepth ? callbacks.getGroupDepth(group.id) : 0;
            const indent = '\u00A0'.repeat(depth * 2);
            const prefix = depth > 0 ? '└ ' : '';
            const $item = $('<div class="luker-preset-ctx-menu__item"></div>')
                .text(isActive ? `${indent}${prefix}${t`In group`}: ${group.name}` : `${indent}${prefix}${t`Move to group`}: ${group.name}`)
                .toggleClass('luker-preset-ctx-menu__item--active', isActive)
                .on('click', async (e) => {
                    e.stopPropagation();
                    dismissContextMenu();
                    if (!isActive) {
                        await callbacks.addToGroup(presetName, group.id);
                        refreshOpenDropdown(selectElement);
                    }
                });
            if (isActive) {
                $item.prepend('<i class="fa-solid fa-check"></i> ');
            }
            $menu.append($item);
        }
    }

    // "Remove from group" if currently grouped
    if (currentGroup) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');
        const $remove = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--remove"></div>')
            .html('<i class="fa-solid fa-folder-minus"></i> ' + t`Remove from preset group`)
            .on('click', async (e) => {
                e.stopPropagation();
                dismissContextMenu();
                await callbacks.removeFromGroup(presetName);
                refreshOpenDropdown(selectElement);
            });
        $menu.append($remove);
    } else if (groups.length === 0) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');
        const $empty = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--label"></div>')
            .text(t`No preset groups yet`);
        $menu.append($empty);
    }

    // Position and show
    const x = anchor instanceof MouseEvent ? anchor.clientX : Number(anchor?.x ?? 0);
    const y = anchor instanceof MouseEvent ? anchor.clientY : Number(anchor?.y ?? 0);

    $menu.css({
        position: 'fixed',
        left: x + 'px',
        top: y + 'px',
        zIndex: 99999,
    });

    $(document.body).append($menu);

    // Dismiss on outside click (next tick)
    requestAnimationFrame(() => {
        $(document).one('pointerdown.lukerCtxMenu', (e) => {
            if (!$(e.target).closest('.luker-preset-ctx-menu').length) {
                dismissContextMenu();
            }
        });
    });
}

/**
 * Initializes a single-select Select2 with optional inline delete actions.
 * @param {JQuery<HTMLElement>|HTMLElement|string} select
 * @param {object} [options]
 * @param {string} [options.placeholder]
 * @param {string} [options.searchInputPlaceholder]
 * @param {boolean} [options.allowClear=false]
 * @param {boolean} [options.closeOnSelect=true]
 * @param {string} [options.deleteButtonTitle='Delete']
 * @param {(option: { ownerKey: string, value: string, text: string, element: HTMLOptionElement|null, selectElement: HTMLSelectElement }) => boolean} [options.canDelete]
 * @param {(option: { ownerKey: string, value: string, text: string, element: HTMLOptionElement|null, selectElement: HTMLSelectElement }) => Promise<void>|void} [options.onDelete]
 * @param {string} [options.containerCssClass]
 * @param {string} [options.dropdownCssClass]
 * @param {object} [options.select2Options]
 * @param {object} [options.presetGroupCallbacks]
 */
export function initActionableSingleSelect(select, {
    placeholder = '',
    searchInputPlaceholder = '',
    allowClear = false,
    closeOnSelect = true,
    deleteButtonTitle = 'Delete',
    canDelete = () => false,
    onDelete = null,
    containerCssClass = '',
    dropdownCssClass = '',
    select2Options = {},
    presetGroupCallbacks = null,
} = {}) {
    const $select = select?.jquery ? select : $(select);
    const selectElement = $select.get(0);

    if (!(selectElement instanceof HTMLSelectElement)) {
        return;
    }

    const previousNamespace = selectElement.dataset.lukerActionableSingleSelectNamespace;
    if (previousNamespace) {
        $select.off(`select2:selecting${previousNamespace} select2:opening${previousNamespace} select2:open${previousNamespace}`);
        $(document).off(`pointerdown${previousNamespace} mousedown${previousNamespace} mouseup${previousNamespace} touchstart${previousNamespace} touchend${previousNamespace} pointerup${previousNamespace} contextmenu${previousNamespace}`);
    }

    const ownerKey = buildOwnerKey(selectElement);
    const namespace = `.lukerActionableSingleSelect-${ownerKey}`;
    const dropdownClasses = ['luker-action-select2-dropdown', dropdownCssClass].filter(Boolean).join(' ');
    selectElement.dataset.lukerActionableSingleSelectNamespace = namespace;

    // Initialize collapsed groups set for this owner
    if (!collapsedGroupsMap.has(ownerKey)) {
        collapsedGroupsMap.set(ownerKey, new Set());
    }
    const collapsedGroups = collapsedGroupsMap.get(ownerKey);

    if ($select.data('select2')) {
        $select.select2('destroy');
    }

    $select.select2({
        placeholder,
        searchInputPlaceholder,
        allowClear,
        closeOnSelect,
        multiple: false,
        dropdownCssClass: dropdownClasses,
        templateResult: (option) => {
            const optionData = getOptionData(option, selectElement, ownerKey);
            const element = option?.element;

            // === Group header ===
                    if (element?.dataset?.presetGroupHeader === 'true') {
                        const groupId = element.dataset.presetGroupId;
                        const isCollapsed = collapsedGroups.has(groupId);
                        const depth = parseInt(element.dataset.depth || '0', 10);
                        const parentId = element.dataset.presetGroupParentId || null;

                        const header = $('<div class="luker-preset-group-header"></div>')
                        .attr('data-preset-group-id', groupId)
                        .attr('data-luker-action-owner', ownerKey)
                        .attr('data-preset-group-parent-id', parentId || '')
                        .css('padding-left', depth > 0 ? (depth * 20) + 'px' : '');
                        const chevron = $('<i class="fa-solid fa-chevron-right luker-preset-group-chevron"></i>')
                    .toggleClass('luker-preset-group-chevron--expanded', !isCollapsed);
                const label = $('<span class="luker-preset-group-header__label"></span>').text(option.text);

                const memberCount = $(selectElement).find('option[data-preset-group-id="' + groupId + '"][data-preset-group-member="true"]').length;
                const count = $('<span class="luker-preset-group-header__count"></span>').text('(' + memberCount + ')');

                const actions = $('<span class="luker-preset-group-header__actions"></span>');
                            const subgroupBtn = $('<button type="button" class="luker-preset-group-action luker-preset-group-subgroup" tabindex="-1"></button>')
                                .attr('data-action', 'subgroup')
                                .attr('data-group-id', groupId)
                                .attr('data-luker-action-owner', ownerKey)
                                .html('<i class="fa-solid fa-folder-plus"></i>');
                            const renameBtn = $('<button type="button" class="luker-preset-group-action" tabindex="-1"></button>')
                    .attr('data-action', 'rename')
                    .attr('data-group-id', groupId)
                    .attr('data-luker-action-owner', ownerKey)
                    .html('<i class="fa-solid fa-pen"></i>');
                const deleteBtn = $('<button type="button" class="luker-preset-group-action" tabindex="-1"></button>')
                    .attr('data-action', 'delete')
                    .attr('data-group-id', groupId)
                    .attr('data-luker-action-owner', ownerKey)
                    .html('<i class="fa-solid fa-trash-can"></i>');
                actions.append(subgroupBtn, renameBtn, deleteBtn);

                header.append(chevron, label, count, actions);
                return header;
            }

            // === Group member ===
                if (element?.dataset?.presetGroupMember === 'true') {
                    const groupId = element.dataset.presetGroupId;
                    const depth = parseInt(element.dataset.depth || '0', 10);

                    const row = $('<div class="luker-action-select2-option luker-preset-group-member"></div>')
                    .attr('data-preset-group-id', groupId)
                    .css('padding-left', depth > 0 ? ((depth + 1) * 20) + 'px' : '');
                    const label = $('<span class="luker-action-select2-option__label"></span>').text(optionData.text);
                row.append(label);

                if (presetGroupCallbacks) {
                    const groupButton = $('<button type="button" class="luker-action-select2-option__group" tabindex="-1"><i class="fa-solid fa-folder-tree"></i></button>')
                        .attr('title', t`Manage preset group`)
                        .attr('aria-label', t`Manage preset group`)
                        .attr('data-luker-action-owner', ownerKey)
                        .attr('data-option-value', optionData.value)
                        .attr('data-option-text', optionData.text);
                    row.append(groupButton);
                }

                if (canDelete(optionData)) {
                    const deleteButton = $('<button type="button" class="luker-action-select2-option__delete" tabindex="-1"><i class="fa-solid fa-trash-can"></i></button>')
                        .attr('title', deleteButtonTitle)
                        .attr('aria-label', deleteButtonTitle)
                        .attr('data-luker-action-owner', ownerKey)
                        .attr('data-option-value', optionData.value)
                        .attr('data-option-text', optionData.text);
                    row.append(deleteButton);
                }

                return row;
            }

            // === Ungrouped (original logic) ===
            if (!option?.element || option.loading || optionData.value === '') {
                return $('<span></span>').text(String(option?.text || ''));
            }

            const row = $('<div class="luker-action-select2-option"></div>');
            const label = $('<span class="luker-action-select2-option__label"></span>').text(optionData.text);
            row.append(label);

            if (presetGroupCallbacks) {
                const groupButton = $('<button type="button" class="luker-action-select2-option__group" tabindex="-1"><i class="fa-solid fa-folder-tree"></i></button>');
                groupButton
                    .attr('title', t`Manage preset group`)
                    .attr('aria-label', t`Manage preset group`)
                    .attr('data-luker-action-owner', ownerKey)
                    .attr('data-option-value', optionData.value)
                    .attr('data-option-text', optionData.text);
                row.append(groupButton);
            }

            if (canDelete(optionData)) {
                const deleteButton = $('<button type="button" class="luker-action-select2-option__delete" tabindex="-1"><i class="fa-solid fa-trash-can"></i></button>');
                deleteButton
                    .attr('title', deleteButtonTitle)
                    .attr('aria-label', deleteButtonTitle)
                    .attr('data-luker-action-owner', ownerKey)
                    .attr('data-option-value', optionData.value)
                    .attr('data-option-text', optionData.text);
                row.append(deleteButton);
            }

            return row;
        },
        ...select2Options,
    });

    $select.next('.select2-container')
        .addClass('luker-action-select2')
        .addClass(containerCssClass);

    $select
        .off('select2:opening' + namespace)
        .on('select2:opening' + namespace, function () {
            if (presetGroupCallbacks && typeof presetGroupCallbacks.rebuild === 'function') {
                presetGroupCallbacks.rebuild();
            }
        });

    // === select2:open - apply collapsed state & default-collapse new groups ===
    $select
        .off('select2:open' + namespace)
        .on('select2:open' + namespace, function () {
            // Default-collapse any groups not yet tracked
            if (presetGroupCallbacks) {
                const groups = presetGroupCallbacks.getGroups();
                for (const group of groups) {
                    if (!collapsedGroups.has(group.id) && !collapsedGroups._initialized?.has(group.id)) {
                        collapsedGroups.add(group.id);
                    }
                }
                // Mark as initialized so we don't re-collapse after user expands
                if (!collapsedGroups._initialized) {
                    Object.defineProperty(collapsedGroups, '_initialized', { value: new Set(), writable: false, enumerable: false });
                }
                for (const group of groups) {
                    collapsedGroups._initialized.add(group.id);
                }
            }

            // Apply after a microtask to let select2 finish rendering
            requestAnimationFrame(() => {
                applyCollapsedState(selectElement, collapsedGroups);

                if (presetGroupCallbacks) {
                    const $dropdown = $select.data('select2')?.$dropdown;
                    const $results = $dropdown?.find('.select2-results');
                    if ($results?.length) {
                        $results.find('.luker-preset-group-toolbar').remove();

                        const $toolbar = $('<div class="luker-preset-group-toolbar"></div>');
                        const $newGroupButton = $('<button type="button" class="luker-preset-group-toolbar__new"></button>')
                            .html('<i class="fa-solid fa-folder-plus"></i> ' + t`New Preset Group...`)
                            .on('click', async (event) => {
                                event.preventDefault();
                                event.stopPropagation();

                                const name = prompt(t`Preset group name:`);
                                if (!name?.trim()) return;
                                await presetGroupCallbacks.createGroup(name.trim());
                                refreshOpenDropdown(selectElement);
                            });

                        $toolbar.append($newGroupButton);
                        $results.prepend($toolbar);
                    }
                }
            });
        });

    // === Prevent selection of group headers and action buttons ===
    $select
        .off('select2:selecting' + namespace)
        .on('select2:selecting' + namespace, function (event) {
            const originalTarget = event?.params?.args?.originalEvent?.target;
            if (isDeleteButtonTarget(originalTarget, ownerKey)) {
                event.preventDefault();
                return;
            }
            if (isGroupMenuButtonTarget(originalTarget, ownerKey)) {
                event.preventDefault();
                return;
            }
            if (isGroupHeaderTarget(originalTarget) || isGroupActionTarget(originalTarget)) {
                event.preventDefault();
                return;
            }
        });

    // === Pointer events for delete buttons, group headers, group actions ===
    $(document)
        .off('pointerdown' + namespace + ' mousedown' + namespace + ' mouseup' + namespace + ' touchstart' + namespace + ' touchend' + namespace)
        .on('pointerdown' + namespace + ' mousedown' + namespace + ' mouseup' + namespace + ' touchstart' + namespace + ' touchend' + namespace, '.luker-action-select2-option__delete, .luker-action-select2-option__group, .luker-preset-group-header, .luker-preset-group-action, .luker-preset-group-subgroup', function (event) {
            const $el = $(this);
            // Only handle events for our owner
            if ($el.data('lukerActionOwner') !== ownerKey && $el.closest('[data-luker-action-owner]').data('lukerActionOwner') !== ownerKey) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
        });

    // === Group menu button handler ===
    $(document)
        .off('pointerup' + namespace + '.groupMenu')
        .on('pointerup' + namespace + '.groupMenu', '.luker-action-select2-option__group', function (event) {
            if ($(this).data('lukerActionOwner') !== ownerKey || !presetGroupCallbacks) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const presetName = String($(this).data('optionText') ?? '').trim();
            if (!presetName) {
                return;
            }

            const rect = this.getBoundingClientRect();
            showPresetContextMenu({ x: rect.right + 6, y: rect.top + rect.height / 2 }, presetName, presetGroupCallbacks, selectElement, ownerKey);
        });

    // === Delete button handler ===
    $(document)
        .off('pointerup' + namespace + '.delete')
        .on('pointerup' + namespace + '.delete', '.luker-action-select2-option__delete', async function (event) {
            if ($(this).data('lukerActionOwner') !== ownerKey || typeof onDelete !== 'function') {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const value = String($(this).data('optionValue') ?? '');
            const text = String($(this).data('optionText') ?? '').trim();
            const optionElement = Array.from(selectElement.options).find((option) => String(option.value) === value && String(option.textContent || '').trim() === text) || null;
            const optionData = {
                ownerKey,
                value,
                text,
                element: optionElement,
                selectElement,
            };

            if (!canDelete(optionData)) {
                return;
            }

            if ($select.data('select2')) {
                $select.select2('close');
            }

            try {
                await onDelete(optionData);
            } catch (error) {
                console.error('Actionable single select delete handler failed', error);
            }
        });

    // === Group header click - toggle collapse ===
        $(document)
        .off('click' + namespace + '.groupHeader')
        .on('click' + namespace + '.groupHeader', '.luker-preset-group-header', function (event) {
            const $header = $(this);
            if ($header.data('lukerActionOwner') !== ownerKey) {
                return;
            }

            // Don't toggle if clicking action buttons or subgroup button
            if ($(event.target).closest('.luker-preset-group-action, .luker-preset-group-subgroup').length) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const groupId = $header.attr('data-preset-group-id');
            if (!groupId) return;

            if (collapsedGroups.has(groupId)) {
                collapsedGroups.delete(groupId);
            } else {
                collapsedGroups.add(groupId);
            }

            applyCollapsedState(selectElement, collapsedGroups);
        });

        // === Group action buttons (rename/delete/create sub-group) ===
        $(document)
        .off('click' + namespace + '.groupAction')
        .on('click' + namespace + '.groupAction', '.luker-preset-group-action, .luker-preset-group-subgroup', async function (event) {
            if ($(this).data('lukerActionOwner') !== ownerKey || !presetGroupCallbacks) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const action = $(this).data('action');
            const groupId = $(this).data('groupId');

            if (action === 'subgroup') {
                const name = prompt(t`Sub-group name:`);
                if (!name?.trim()) return;

                if ($select.data('select2')) {
                    $select.select2('close');
                }

                await presetGroupCallbacks.createGroup(name.trim(), groupId);
                refreshOpenDropdown(selectElement);
            } else if (action === 'rename') {
                const groups = presetGroupCallbacks.getGroups();
                const group = groups.find(g => g.id === groupId);
                if (!group) return;

                const newName = prompt(t`Rename preset group:`, group.name);
                if (!newName?.trim() || newName.trim() === group.name) return;

                if ($select.data('select2')) {
                    $select.select2('close');
                }

                await presetGroupCallbacks.renameGroup(groupId, newName.trim());
                refreshOpenDropdown(selectElement);
            } else if (action === 'delete') {
                if (!confirm(t`Delete this preset group? Presets will become ungrouped.`)) return;

                if ($select.data('select2')) {
                    $select.select2('close');
                }

                collapsedGroups.delete(groupId);
                await presetGroupCallbacks.deleteGroup(groupId);
                refreshOpenDropdown(selectElement);
            }
        });

}
