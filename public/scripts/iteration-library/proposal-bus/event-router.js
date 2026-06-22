// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Single-source click dispatcher for ProposalBus. Popups install one
 * delegated handler at root and call bus.handleClick(event) first;
 * the bus consumes events with data-proposal-action and ignores the
 * rest (returning false so the popup's own handler chain can process them).
 */

const ACTIONS = new Set([
    'approve',
    'reject',
    'reset',
    'rollback',
    'force-discard',
    'export-record',
    'approve-all-pending',
    'reject-all-pending',
    'rollback-turn',
]);

export async function dispatch(event, bus, messageResolver) {
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return false;
    const trigger = target.closest('[data-proposal-action]');
    if (!trigger || typeof trigger.getAttribute !== 'function') return false;
    const action = String(trigger.getAttribute('data-proposal-action') || '');
    if (!ACTIONS.has(action)) return false;
    const proposalId = trigger.getAttribute('data-proposal-id');
    const messageId = trigger.getAttribute('data-proposal-message-id');
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    switch (action) {
        case 'approve':  await bus.approve(proposalId); break;
        case 'reject':   bus.reject(proposalId); break;
        case 'reset':    bus.reset(proposalId); break;
        case 'rollback': await bus.rollback(proposalId); break;
        case 'force-discard':  bus.forceDiscard(proposalId); break;
        case 'export-record':  bus.exportRecord(proposalId); break;
        case 'approve-all-pending': {
            const msg = messageResolver ? messageResolver(messageId) : { id: messageId };
            await bus.approveAllPendingInTurn(msg);
            break;
        }
        case 'reject-all-pending': {
            const msg = messageResolver ? messageResolver(messageId) : { id: messageId };
            bus.rejectAllPendingInTurn(msg);
            break;
        }
        case 'rollback-turn': {
            const msg = messageResolver ? messageResolver(messageId) : { id: messageId };
            await bus.rollbackAllInTurn(msg);
            break;
        }
    }
    return true;
}
