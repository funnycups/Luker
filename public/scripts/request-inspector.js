/**
 * Request Inspector — DevTools-like Network panel for generation requests.
 */

import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { getRequestHeaders } from '../script.js';
import { createRequestInspector } from './request-inspector-core.js';

export { createRequestInspector };

const inspector = createRequestInspector({ callGenericPopup, POPUP_TYPE, getRequestHeaders });

export async function openRequestInspector(requestId = '') {
    return inspector.openRequestInspector(requestId);
}

jQuery(() => {
    const $btn = $(`
 <div id="request_inspector_button" class="margin0 menu_button_icon menu_button">
 <i class="fa-fw fa-solid fa-satellite-dish"></i>
 <span data-i18n="Inspector">Inspector</span>
 </div>
 `);

    $btn.on('click', () => openRequestInspector());

    const $logsBtn = $('#server_logs_button');
    if ($logsBtn.length) {
        $logsBtn.after($btn);
    } else {
        $('#account_controls').append($btn);
    }
});
