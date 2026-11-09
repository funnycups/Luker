import { expect, test } from '@jest/globals';
import {
    createStudioSession, sessionTitleFromText, appendStudioUserMessage,
    appendStudioAssistantTurn, buildStudioHistoryMessages,
} from '../public/scripts/extensions/stable-diffusion/illustration/studio/session.js';

test('creates a session and titles it from the first user message', () => {
    const session = createStudioSession({ presetId: 'p', now: 1 });
    appendStudioUserMessage(session, '画一座海边的灯塔', 2);
    expect(session.title).toBe('画一座海边的灯塔');
    expect(sessionTitleFromText('a'.repeat(80))).toHaveLength(60);
});

test('assistant tool turn produces assistant and tool history messages', () => {
    const session = createStudioSession({ presetId: 'p', now: 1 });
    appendStudioUserMessage(session, '画灯塔', 2);
    appendStudioAssistantTurn(session, {
        text: '生成中',
        toolCalls: [{ name: 'generate_image', arguments: { prompt: 'lighthouse' } }],
        toolResults: [{ tool_call_id: 'call_1', content: '{"status":"ready","url":"/user/images/a.png"}' }],
        images: [{ id: 'img_1', prompt: 'lighthouse', imageUrl: '/user/images/a.png', status: 'ready' }],
        now: 3,
    });
    const history = buildStudioHistoryMessages(session);
    expect(history[0]).toEqual({ role: 'user', content: '画灯塔' });
    expect(history[1].role).toBe('assistant');
    expect(history[1].tool_calls[0].function.name).toBe('generate_image');
    expect(history[2]).toEqual({
        role: 'tool', tool_call_id: 'call_1',
        content: '{"status":"ready","url":"/user/images/a.png"}',
    });
    expect(session.images).toHaveLength(1);
});
