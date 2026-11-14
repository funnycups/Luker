import { jest } from '@jest/globals';
import { emitMessageChanged } from '../public/scripts/extensions/stable-diffusion/illustration/message-events.js';

test('announces an edited message before the generic update', async () => {
    const events = [];
    const context = {
        eventSource: {
            emit: jest.fn(async (...args) => { events.push(args); }),
        },
        eventTypes: {
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_UPDATED: 'message_updated',
        },
    };

    await emitMessageChanged(context, 7);

    expect(events).toEqual([
        ['message_edited', 7, null],
        ['message_updated', 7],
    ]);
});
