// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import { PlainTextFunctionCallStreamDetector } from '../public/scripts/extensions/function-call-runtime.js';

describe('PlainTextFunctionCallStreamDetector streaming argument preview', () => {
    const trigger = '<Function_Test99_Start/>';

    test('streams target string argument from CDATA args_json while masking raw XML', () => {
        const detector = new PlainTextFunctionCallStreamDetector({ triggerSignal: trigger });
        const chunks = [
            '<thought>plan</thought>\n',
            '<Function_Test',
            '99_Start/>\n<function_calls>\n  <function_call>\n    <tool>reply</tool>\n    <args_json><![CDATA[{"body":"春',
            '风\\n\\"十里\\uD8',
            '3D\\uDE00',
            '"}]]></args_json>\n  </function_call>\n</function_calls>',
        ];

        const displayParts = [];
        const previews = [];
        for (const chunk of chunks) {
            displayParts.push(detector.processTextDelta(chunk).displayDelta);
            previews.push(detector.getToolCallPreview('reply', 'body'));
        }

        expect(displayParts.join('')).toBe('<thought>plan</thought>\n');
        expect(previews).toEqual([
            '',
            '',
            '春',
            '春风\n"十里',
            '春风\n"十里😀',
            '春风\n"十里😀',
        ]);
        expect(detector.getToolCallPreview('other', 'body')).toBe('');
    });

    test('handles split CDATA concatenation (]]]]><![CDATA[>) without truncating or leaking boundaries', () => {
        const detector = new PlainTextFunctionCallStreamDetector({ triggerSignal: trigger });
        const full = `${trigger}\n<function_calls><function_call><tool>reply</tool><args_json><![CDATA[{"body":"a]]]]><![CDATA[>b"}]]></args_json></function_call></function_calls>`;
        const seen = [];
        for (let i = 0; i < full.length; i += 3) {
            detector.processTextDelta(full.slice(i, i + 3));
            const preview = detector.getToolCallPreview('reply', 'body');
            if (preview) {
                expect(preview).not.toContain('CDATA');
                seen.push(preview);
            }
        }
        expect(seen[seen.length - 1]).toBe('a]]>b');
    });

    test('decodes non-CDATA XML entities split across chunk boundaries', () => {
        const detector = new PlainTextFunctionCallStreamDetector({ triggerSignal: trigger });
        const chunks = [
            `${trigger}\n<function_calls><function_call><tool>reply</tool><args_json>{&qu`,
            'ot;body&quot;:&quot;A &am',
            'p; B &l',
            't;ok&gt; &apos;hi&apos;&quot;}</ar',
            'gs_json></function_call></function_calls>',
        ];
        const previews = [];
        for (const chunk of chunks) {
            detector.processTextDelta(chunk);
            previews.push(detector.getToolCallPreview('reply', 'body'));
        }
        expect(previews[0]).toBe('');
        expect(previews[1]).toBe('A ');
        expect(previews[2]).toBe('A & B ');
        expect(previews[3]).toBe('A & B <ok> \'hi\'');
        expect(previews[4]).toBe('A & B <ok> \'hi\'');
    });

    test('skips non-matching earlier function_call blocks and previews nested paths on the target call', () => {
        const detector = new PlainTextFunctionCallStreamDetector({ triggerSignal: trigger });
        detector.processTextDelta(
            `${trigger}\n<function_calls>`
            + '<function_call><tool>log</tool><args_json><![CDATA[{"payload":{"text":"WRONG"}}]]></args_json></function_call>'
            + '<function_call><tool>reply</tool><args_json><![CDATA[{"payload":{"text":"RIGHT',
        );
        expect(detector.getToolCallPreview('reply', 'payload.text')).toBe('RIGHT');
        detector.processTextDelta('!"}}]]></args_json></function_call></function_calls>');
        expect(detector.getToolCallPreview('reply', 'payload.text')).toBe('RIGHT!');
    });

    test('resets preview to the call region after the last trigger when model re-emits triggerSignal', () => {
        const detector = new PlainTextFunctionCallStreamDetector({ triggerSignal: trigger });
        detector.processTextDelta(`${trigger}\n<function_calls><function_call><tool>reply</tool><args_json><![CDATA[{"body":"stale`);
        expect(detector.getToolCallPreview('reply', 'body')).toBe('stale');

        detector.processTextDelta(`"}]]>\n${trigger}\n<function_calls><function_call><tool>reply</tool><args_json><![CDATA[{"body":"fresh`);
        expect(detector.getToolCallPreview('reply', 'body')).toBe('fresh');
    });

    test('does not falsely preview args_json before tool name is confirmed when tags appear out of order', () => {
        const detector = new PlainTextFunctionCallStreamDetector({ triggerSignal: trigger });
        detector.processTextDelta(`${trigger}\n<function_calls><function_call><args_json><![CDATA[{"body":"maybe"}]]></args_json>`);
        expect(detector.getToolCallPreview('reply', 'body')).toBe('');
        detector.processTextDelta('<tool>reply</tool></function_call></function_calls>');
        expect(detector.getToolCallPreview('reply', 'body')).toBe('maybe');
    });
});
