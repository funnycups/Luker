import { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import { deleteMediaFromServer } from '../../../chats.js';
import { createIllustrationActions, filterReplayReferences } from './actions-core.js';

export { createIllustrationActions, filterReplayReferences };

export function initIllustrationActions(options) {
    return createIllustrationActions({
        ...options,
        ui: { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup },
        deleteMediaFromServer,
    });
}
