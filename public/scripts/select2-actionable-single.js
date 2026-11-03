import { t } from './i18n.js';
import { createSelectionState } from './select2-multiselect.js';

let actionableSingleSelectCounter = 0;

/** @type {Map<string, Set<string>>} ownerKey -> collapsed group IDs (session-only) */
const collapsedGroupsMap = new Map();

/** @type {WeakMap<HTMLSelectElement, AbortController>} select -> capturing checkbox guard */
const multiselectGuardControllers = new WeakMap();

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

function isCheckboxTarget(target, ownerKey) {
    if (!(target instanceof Element)) {
        return false;
    }

    const checkbox = target.closest('.luker-action-select2-option__checkbox');
    return checkbox instanceof HTMLElement && checkbox.dataset.lukerActionOwner === ownerKey;
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
export function refreshOpenDropdown(selectElement, ownerKey = '') {
    const $select = $(selectElement);
    const isOpen = $select.next('.select2-container').hasClass('select2-container--open');
    if (isOpen) {
        const select2 = $select.data('select2');
        if (!select2) return;

        const $results = select2.$dropdown?.find('.select2-results__options');
        const scrollTop = $results?.scrollTop() ?? 0;
        const term = String(select2.dropdown?.$search?.val?.() ?? '');
        const params = term ? { term } : {};

        if (typeof select2.dataAdapter?.query === 'function' && typeof select2.trigger === 'function') {
            select2.dataAdapter.query(params, (data) => {
                select2.trigger('results:all', { data, query: params });
                requestAnimationFrame(() => {
                    const $updatedResults = select2.$dropdown?.find('.select2-results__options');
                    if ($updatedResults?.length) {
                        $updatedResults.scrollTop(scrollTop);
                    }

                    const collapsedGroups = ownerKey ? collapsedGroupsMap.get(ownerKey) : null;
                    if (collapsedGroups) {
                        applyCollapsedState(selectElement, collapsedGroups);
                    }
                });
            });
            return;
        }

        $select.trigger('change.select2');
    } else {
        $select.select2('open');
    }
}

/**
 * Dismisses any open preset context menu.
 */
function dismissContextMenu() {
    $('.luker-preset-ctx-menu').remove();
    $(document).off('pointerdown.lukerCtxMenu');
    $('.luker-action-select2-option__group--selected').removeClass('luker-action-select2-option__group--selected');
}

function getOpenPresetContextMenu(ownerKey) {
    return $('.luker-preset-ctx-menu').filter(function () {
        return this.dataset.lukerActionOwner === ownerKey;
    }).first();
}

function getPresetContextSelection($menu) {
    const selected = $menu.data('selectedPresetNames');
    return Array.isArray(selected) ? selected : [];
}

function syncPresetContextSelectionState(ownerKey, selectedPresetNames = []) {
    const selected = new Set(selectedPresetNames);
    $('.luker-action-select2-option__group').each(function () {
        const $button = $(this);
        if ($button.data('lukerActionOwner') !== ownerKey) {
            return;
        }
        const presetName = String($button.data('optionText') ?? '').trim();
        $button.toggleClass('luker-action-select2-option__group--selected', selected.has(presetName));
    });
}

/**
 * Repositions a context menu so it always stays within the viewport.
 * @param {JQuery<HTMLElement>} $menu
 * @param {number} x
 * @param {number} y
 */
function positionContextMenuInViewport($menu, x, y) {
    if (!$menu?.length) {
        return;
    }

    const margin = 8;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth ?? document.documentElement.clientWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight ?? document.documentElement.clientHeight;
    const menuWidth = $menu.outerWidth() ?? 0;
    const menuHeight = $menu.outerHeight() ?? 0;

    const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
    const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);

    const left = Math.min(Math.max(margin, x), maxLeft);
    const top = Math.min(Math.max(margin, y), maxTop);

    $menu.css({
        left: left + 'px',
        top: top + 'px',
    });
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
    const $existingMenu = getOpenPresetContextMenu(ownerKey);
    const existingSelection = getPresetContextSelection($existingMenu);
    const keepPosition = $existingMenu.length > 0;
    let selectedPresetNames = [presetName].filter(Boolean);

    if (keepPosition && selectedPresetNames.length) {
        if (existingSelection.includes(presetName)) {
            selectedPresetNames = existingSelection.length > 1 ? existingSelection.filter(name => name !== presetName) : existingSelection;
        } else {
            selectedPresetNames = [...existingSelection, presetName];
        }
    }

    selectedPresetNames = Array.from(new Set(selectedPresetNames));

    const existingX = Number.parseFloat($existingMenu.css('left'));
    const existingY = Number.parseFloat($existingMenu.css('top'));

    dismissContextMenu();
    if (!callbacks) return;

    const groups = callbacks.getGroups();
    const selectedGroups = selectedPresetNames.map(name => callbacks.getGroupForPreset(name));
    const currentGroup = selectedPresetNames.length === 1 ? selectedGroups[0] : null;
    const commonGroup = selectedGroups.length > 0 && selectedGroups.every(group => group?.id === selectedGroups[0]?.id) ? selectedGroups[0] : null;
    const hasGroupedPreset = selectedGroups.some(Boolean);

    const $menu = $('<div class="luker-preset-ctx-menu"></div>')
        .attr('data-luker-action-owner', ownerKey)
        .data('selectedPresetNames', selectedPresetNames)
        .on('pointerdown mousedown mouseup pointerup touchstart touchend click', (e) => {
            e.stopPropagation();
        });

    // "New Group..." option
    const $newGroup = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--new"></div>')
        .html('<i class="fa-solid fa-folder-plus"></i> ' + t`New Preset Group...`)
        .on('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dismissContextMenu();
            const name = prompt(t`Preset group name:`);
            if (!name?.trim()) return;
            const groupId = await callbacks.createGroup(name.trim(), commonGroup?.id);
            if (groupId) {
                for (const selectedPresetName of selectedPresetNames) {
                    await callbacks.addToGroup(selectedPresetName, groupId);
                }
            }
            if (typeof callbacks.rebuild === 'function') {
                callbacks.rebuild();
            }
            refreshOpenDropdown(selectElement, ownerKey);
        });
    $menu.append($newGroup);

    // Existing groups
    if (groups.length > 0) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');

        if (selectedPresetNames.length > 1) {
            const $current = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--label"></div>')
                .text(`${t`Selected presets`}: ${selectedPresetNames.length}`);
            $menu.append($current);
        } else if (currentGroup) {
            const $current = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--label"></div>')
                .text(`${t`Current group`}: ${currentGroup.name}`);
            $menu.append($current);
        } else {
            const $current = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--label"></div>')
                .text(t`Current group: Ungrouped`);
            $menu.append($current);
        }

        for (const group of groups) {
            const isActive = selectedPresetNames.length > 0 && selectedGroups.every(selectedGroup => selectedGroup?.id === group.id);
            const depth = callbacks.getGroupDepth ? callbacks.getGroupDepth(group.id) : 0;
            const indent = '\u00A0'.repeat(depth * 2);
            const prefix = depth > 0 ? '└ ' : '';
            const $item = $('<div class="luker-preset-ctx-menu__item"></div>')
                .text(isActive ? `${indent}${prefix}${t`In group`}: ${group.name}` : `${indent}${prefix}${t`Move to group`}: ${group.name}`)
                .toggleClass('luker-preset-ctx-menu__item--active', isActive)
                .on('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dismissContextMenu();
                    if (!isActive) {
                        for (const selectedPresetName of selectedPresetNames) {
                            await callbacks.addToGroup(selectedPresetName, group.id);
                        }
                        if (typeof callbacks.rebuild === 'function') {
                            callbacks.rebuild();
                        }
                        refreshOpenDropdown(selectElement, ownerKey);
                    }
                });
            if (isActive) {
                $item.prepend('<i class="fa-solid fa-check"></i> ');
            }
            $menu.append($item);
        }
    }

    // "Remove from group" if currently grouped
    if (hasGroupedPreset) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');
        const $remove = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--remove"></div>')
            .html('<i class="fa-solid fa-folder-minus"></i> ' + t`Remove from preset group`)
            .on('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                dismissContextMenu();
                for (const selectedPresetName of selectedPresetNames) {
                    await callbacks.removeFromGroup(selectedPresetName);
                }
                if (typeof callbacks.rebuild === 'function') {
                    callbacks.rebuild();
                }
                refreshOpenDropdown(selectElement, ownerKey);
            });
        $menu.append($remove);
    } else if (groups.length === 0) {
        $menu.append('<div class="luker-preset-ctx-menu__divider"></div>');
        const $empty = $('<div class="luker-preset-ctx-menu__item luker-preset-ctx-menu__item--label"></div>')
            .text(t`No preset groups yet`);
        $menu.append($empty);
    }

    // Position and show
    const x = keepPosition && Number.isFinite(existingX) ? existingX : anchor instanceof MouseEvent ? anchor.clientX : Number(anchor?.x ?? 0);
    const y = keepPosition && Number.isFinite(existingY) ? existingY : anchor instanceof MouseEvent ? anchor.clientY : Number(anchor?.y ?? 0);

    $menu.css({
        position: 'fixed',
        left: x + 'px',
        top: y + 'px',
        zIndex: 99999,
    });

    $(document.body).append($menu);
    positionContextMenuInViewport($menu, x, y);
    syncPresetContextSelectionState(ownerKey, selectedPresetNames);

    // Dismiss on outside click (next tick)
    requestAnimationFrame(() => {
        $(document).off('pointerdown.lukerCtxMenu').on('pointerdown.lukerCtxMenu', (e) => {
            const $target = $(e.target);
            const $groupButton = $target.closest('.luker-action-select2-option__group');
            if ($target.closest('.luker-preset-ctx-menu').length) {
                return;
            }
            if ($groupButton.length && $groupButton.data('lukerActionOwner') === ownerKey) {
                return;
            }
            if ($target.closest('.luker-action-select2-dropdown').length) {
                return;
            }
            dismissContextMenu();
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
 * @param {((options: Array<{ ownerKey: string, value: string, text: string, element: HTMLOptionElement|null, selectElement: HTMLSelectElement }>) => Promise<void>|void)|null} [options.onBulkDelete]
 * @param {string} [options.bulkDeleteButtonTitle='Delete']
 * @param {((options: Array<{ ownerKey: string, value: string, text: string, element: HTMLOptionElement|null, selectElement: HTMLSelectElement }>) => Promise<void>|void)|null} [options.onBulkExport]
 * @param {string} [options.bulkExportButtonTitle='Export']
 * @param {string} [options.selectAllTitle='Select all']
 * @param {string} [options.selectedLabel='Selected']
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
    onBulkDelete = null,
    bulkDeleteButtonTitle = 'Delete',
    onBulkExport = null,
    bulkExportButtonTitle = 'Export',
    selectAllTitle = 'Select all',
    selectedLabel = 'Selected',
} = {}) {
    const $select = select?.jquery ? select : $(select);
    const selectElement = $select.get(0);

    if (!(selectElement instanceof HTMLSelectElement)) {
        return;
    }

    const previousNamespace = selectElement.dataset.lukerActionableSingleSelectNamespace;
    if (previousNamespace) {
        $select.off(`select2:selecting${previousNamespace} select2:opening${previousNamespace} select2:open${previousNamespace} select2:close${previousNamespace}`);
        $(document).off(`pointerdown${previousNamespace} mousedown${previousNamespace} mouseup${previousNamespace} touchstart${previousNamespace} touchend${previousNamespace} pointerup${previousNamespace} click${previousNamespace} contextmenu${previousNamespace}`);
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

    // Multi-select batch mode: a checkbox per deletable row, a toolbar, and a
    // merged delete. The wrapper owns selection UI only; the call site owns the
    // confirm, the delete, the undo, and its own refresh.
    const selection = createSelectionState();
    const bulkDeleteEnabled = typeof onBulkDelete === 'function';
    const bulkExportEnabled = typeof onBulkExport === 'function';
    const bulkActionsEnabled = bulkDeleteEnabled || bulkExportEnabled;

    const getDropdown = () => $select.data('select2')?.$dropdown;

    // `$dropdown` is select2's outer wrapper span (the `attachBody` decorator
    // returns its own container), so the class that carries `dropdownCssClass`
    // lives on the `.select2-dropdown` element inside it.
    const getDropdownSurface = () => {
        const $dropdown = getDropdown();
        if (!$dropdown?.length) {
            return null;
        }

        return $dropdown.hasClass('select2-dropdown') ? $dropdown : $dropdown.find('.select2-dropdown').first();
    };

    const buildRowCheckbox = (optionData) => {
        return $('<input type="checkbox" class="luker-action-select2-option__checkbox" tabindex="-1">')
            .attr('data-luker-action-owner', ownerKey)
            .attr('data-option-value', optionData.value)
            .attr('title', optionData.text)
            .prop('checked', selection.has(optionData.value));
    };

    const getRenderedSelectableValues = () => {
        const $dropdown = getDropdown();
        if (!$dropdown?.length) {
            return [];
        }

        const values = [];
        $dropdown.find('.select2-results__option .luker-action-select2-option__checkbox').each(function () {
            values.push(String($(this).attr('data-option-value') ?? ''));
        });
        return values;
    };

    // Row clicks in batch mode toggle the row's checkbox, so a near miss
    // between two checkboxes must not reach select2's selection handler.
    // Returns the row's own checkbox when the row is toggleable.
    const getRowToggleCheckbox = (target) => {
        if (!(target instanceof Element)) {
            return null;
        }

        const $row = $(target).closest('.select2-results__option');
        if (!$row.length) {
            return null;
        }

        const checkbox = $row.find('.luker-action-select2-option__checkbox').get(0);
        return checkbox instanceof HTMLElement && checkbox.dataset.lukerActionOwner === ownerKey ? checkbox : null;
    };

    const getSelectedItems = () => selection.values().map((value) => {
        const optionElement = Array.from(selectElement.options).find((option) => String(option.value) === value) || null;
        return {
            ownerKey,
            value,
            text: String(optionElement?.textContent || '').trim(),
            element: optionElement,
            selectElement,
        };
    }).filter((optionData) => canDelete(optionData));

    const applyBatchMode = (active) => {
        const $surface = getDropdownSurface();
        if ($surface?.length) {
            $surface.toggleClass('luker-multiselect-active', active);
        }
    };

    const syncCheckboxTicks = () => {
        const $dropdown = getDropdown();
        if (!$dropdown?.length) {
            return;
        }

        $dropdown.find('.luker-action-select2-option__checkbox').each(function () {
            $(this).prop('checked', selection.has($(this).attr('data-option-value')));
        });
    };

    const renderBulkToolbar = () => {
        const $results = getDropdown()?.find('.select2-results');
        if (!$results?.length) {
            return;
        }

        $results.find('.luker-bulk-delete-toolbar').remove();

        if (!bulkActionsEnabled || selection.size() === 0) {
            applyBatchMode(false);
            return;
        }

        const renderedValues = getRenderedSelectableValues();
        const allRenderedSelected = renderedValues.length > 0 && renderedValues.every((value) => selection.has(value));

        const $toolbar = $('<div class="luker-bulk-delete-toolbar"></div>')
            .attr('data-luker-action-owner', ownerKey);
        const $selectAll = $('<input type="checkbox" class="luker-bulk-delete-toolbar__select-all">')
            .attr('data-luker-action-owner', ownerKey)
            .attr('title', selectAllTitle)
            .attr('aria-label', selectAllTitle)
            .prop('checked', allRenderedSelected)
            .on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();

                const values = getRenderedSelectableValues();
                if (!values.length) {
                    return;
                }

                if (values.every((value) => selection.has(value))) {
                    selection.remove(values);
                } else {
                    selection.add(values);
                }

                syncCheckboxTicks();
                renderBulkToolbar();
            });
        const $count = $('<span class="luker-bulk-delete-toolbar__count"></span>')
            .text(`${selectedLabel}: ${selection.size()}`);
        const $export = bulkExportEnabled
            ? $('<button type="button" class="luker-bulk-delete-toolbar__export"></button>')
                .attr('data-luker-action-owner', ownerKey)
                .attr('title', bulkExportButtonTitle)
                .attr('aria-label', bulkExportButtonTitle)
                .text(bulkExportButtonTitle)
            : null;
        const $delete = $('<button type="button" class="luker-bulk-delete-toolbar__delete"></button>')
            .attr('data-luker-action-owner', ownerKey)
            .attr('title', bulkDeleteButtonTitle)
            .attr('aria-label', bulkDeleteButtonTitle)
            .text(bulkDeleteButtonTitle);

        $toolbar.append($selectAll, $count);
        if ($export) {
            $toolbar.append($export);
        }
        $toolbar.append($delete);
        $results.prepend($toolbar);
        applyBatchMode(true);
    };

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
                if (bulkActionsEnabled && canDelete(optionData)) {
                    row.append(buildRowCheckbox(optionData));
                }
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
            if (bulkActionsEnabled && canDelete(optionData)) {
                row.append(buildRowCheckbox(optionData));
            }
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
                                if (typeof presetGroupCallbacks.rebuild === 'function') {
                                    presetGroupCallbacks.rebuild();
                                }
                                refreshOpenDropdown(selectElement, ownerKey);
                            });

                        $toolbar.append($newGroupButton);
                        $results.prepend($toolbar);
                    }
                }

                renderBulkToolbar();
            });
        });

    $select
        .off('select2:close' + namespace)
        .on('select2:close' + namespace, function () {
            dismissContextMenu();
            selection.clear();
            renderBulkToolbar();
        });

    // === Prevent selection of group headers and action buttons ===
    $select
        .off('select2:selecting' + namespace)
        .on('select2:selecting' + namespace, function (event) {
            const originalTarget = event?.params?.args?.originalEvent?.target;
            if (isCheckboxTarget(originalTarget, ownerKey)) {
                event.preventDefault();
                return;
            }
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

    // === Multi-select checkbox handler ===
    // Bound to `click`, not `pointerup`: the checkbox owns its own checked
    // state, and the native toggle lands on `click`. Toggling from `pointerup`
    // would race that toggle. `select2:selecting` above is what stops the row
    // from being selected.
    //
    // The capturing `mouseup` guard is load-bearing. select2 listens for
    // `mouseup` on the results list and, when the clicked row is the option
    // that is already selected, it fires `close` rather than `select` — and
    // `select2:selecting` cannot veto a close. Without the guard, ticking the
    // checkbox on the currently selected row would dismiss the dropdown and
    // silently drop the batch selection. The listener must capture, because
    // select2's listener sits on an ancestor and a delegated document handler
    // runs after it. The same guard covers row clicks in batch mode, where the
    // row is the checkbox's hit area: otherwise any click outside the checkbox
    // would select the option, close the dropdown and drop the batch selection.
    multiselectGuardControllers.get(selectElement)?.abort();
    const guardController = new AbortController();
    multiselectGuardControllers.set(selectElement, guardController);

    document.addEventListener('mouseup', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const checkbox = target.closest('.luker-action-select2-option__checkbox');
        if (checkbox instanceof HTMLElement && checkbox.dataset.lukerActionOwner === ownerKey) {
            event.stopPropagation();
            return;
        }

        if (selection.size() > 0 && getRowToggleCheckbox(target)) {
            event.stopPropagation();
        }
    }, { capture: true, signal: guardController.signal });

    $(document)
        .off('click' + namespace + '.multiselect')
        .on('click' + namespace + '.multiselect', '.luker-action-select2-option__checkbox', function (event) {
            if ($(this).attr('data-luker-action-owner') !== ownerKey) {
                return;
            }

            event.stopPropagation();

            // Deliberately no preventDefault(): cancelling a checkbox click
            // makes the browser restore the pre-click checkedness after this
            // handler returns, wiping whatever we set here. The native toggle
            // has already run, so `this.checked` is the new state and is the
            // authority; the selection set follows it.
            const value = String($(this).attr('data-option-value') ?? '');
            if (this.checked) {
                selection.add([value]);
            } else {
                selection.remove([value]);
            }
            renderBulkToolbar();
        });

    // === Multi-select row handler ===
    // While the batch selection is active, the whole row acts as the
    // checkbox's hit area so a click that lands between two checkboxes ticks
    // the row instead of switching presets and closing the dropdown.
    $(document)
        .off('click' + namespace + '.rowToggle')
        .on('click' + namespace + '.rowToggle', '.select2-results__option', function (event) {
            if (selection.size() === 0) {
                return;
            }

            const rowCheckbox = getRowToggleCheckbox(this);
            if (!rowCheckbox) {
                return;
            }

            // The checkbox owns its own click handler above.
            const target = event.target;
            if (target instanceof Element && target.closest('.luker-action-select2-option__checkbox')) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const value = String(rowCheckbox.dataset.optionValue ?? '');
            if (!value) {
                return;
            }

            if (selection.has(value)) {
                selection.remove([value]);
            } else {
                selection.add([value]);
            }

            rowCheckbox.checked = selection.has(value);
            renderBulkToolbar();
        });

    // === Bulk delete toolbar handler ===
    // `click` rather than `pointerup`: a `<button>` fires `click` for mouse,
    // touch, Enter and Space alike, so the toolbar stays operable from the
    // keyboard. `pointerup` alone only covered pointing devices.
    $(document)
        .off('click' + namespace + '.bulkDelete')
        .on('click' + namespace + '.bulkDelete', '.luker-bulk-delete-toolbar__delete', async function (event) {
            if ($(this).attr('data-luker-action-owner') !== ownerKey || typeof onBulkDelete !== 'function') {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const items = getSelectedItems();

            if (!items.length) {
                return;
            }

            if ($select.data('select2')) {
                $select.select2('close');
            }

            try {
                await onBulkDelete(items);
            } catch (error) {
                console.error('Actionable single select bulk delete handler failed', error);
            }
        });

    // === Bulk export toolbar handler ===
    $(document)
        .off('click' + namespace + '.bulkExport')
        .on('click' + namespace + '.bulkExport', '.luker-bulk-delete-toolbar__export', async function (event) {
            if ($(this).attr('data-luker-action-owner') !== ownerKey || typeof onBulkExport !== 'function') {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const items = getSelectedItems();

            if (!items.length) {
                return;
            }

            if ($select.data('select2')) {
                $select.select2('close');
            }

            try {
                await onBulkExport(items);
            } catch (error) {
                console.error('Actionable single select bulk export handler failed', error);
            }
        });

    // === Group header pointerup - toggle collapse (pointerup for WebView touch handling) ===
    $(document)
        .off('pointerup' + namespace + '.groupHeader')
        .on('pointerup' + namespace + '.groupHeader', '.luker-preset-group-header', function (event) {
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

    // === Group action buttons (rename/delete/create sub-group) — pointerup for WebView touch handling ===
    $(document)
        .off('pointerup' + namespace + '.groupAction')
        .on('pointerup' + namespace + '.groupAction', '.luker-preset-group-action, .luker-preset-group-subgroup', async function (event) {
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
                if (typeof presetGroupCallbacks.rebuild === 'function') {
                    presetGroupCallbacks.rebuild();
                }
                refreshOpenDropdown(selectElement, ownerKey);
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
                if (typeof presetGroupCallbacks.rebuild === 'function') {
                    presetGroupCallbacks.rebuild();
                }
                refreshOpenDropdown(selectElement, ownerKey);
            } else if (action === 'delete') {
                if (!confirm(t`Delete this preset group? Presets will become ungrouped.`)) return;

                if ($select.data('select2')) {
                    $select.select2('close');
                }

                collapsedGroups.delete(groupId);
                await presetGroupCallbacks.deleteGroup(groupId);
                if (typeof presetGroupCallbacks.rebuild === 'function') {
                    presetGroupCallbacks.rebuild();
                }
                refreshOpenDropdown(selectElement, ownerKey);
            }
        });
}
