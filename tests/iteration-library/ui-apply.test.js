import { jest } from '@jest/globals';
import { renderApplyControls } from '../../public/scripts/iteration-library/ui/apply.js';

const ident = (s, ...args) => args.reduce((acc, v, i) => acc.replace(new RegExp('\\$\\{' + i + '\\}', 'g'), v), s);

describe('renderApplyControls', () => {
    it('renders pending Apply + Discard buttons for unapplied message with edits', () => {
        const html = renderApplyControls(
            { id: 'm1', edits: [{ op: 'set' }] },
            { i18n: ident, applyLabel: 'Apply 1 change' },
        );
        expect(html).toMatch(/apply/i);
        expect(html).toMatch(/discard/i);
    });

    it('renders Rollback row when applied with journal', () => {
        const html = renderApplyControls(
            { id: 'm2', edits: [{ op: 'set' }], appliedAt: Date.now(), appliedTarget: 'character' },
            { i18n: ident },
        );
        expect(html).toMatch(/rollback/i);
    });

    it('renders read-only Rolled-back status when rolledBackAt is set', () => {
        const html = renderApplyControls(
            { id: 'm3', rolledBackAt: Date.now() },
            { i18n: ident },
        );
        expect(html).toMatch(/rolled back|回滚|回退/i);
        expect(html).not.toMatch(/<button/);
    });

    it('omits everything when edits is empty and no applied/rolled-back stamps', () => {
        const html = renderApplyControls(
            { id: 'm4', edits: [] },
            { i18n: ident },
        );
        expect(html.trim()).toBe('');
    });

    it('honors appliedTarget by emitting the "Applied to ${0} at ${1}" form', () => {
        // The applied branch used to always render `✓ Applied at HH:MM`
        // and silently drop `message.appliedTarget`. message.js's
        // analogous branch uses the to-form when a target is present;
        // apply.js must mirror that pattern so the user sees which
        // surface the change landed on (preset / schema / character).
        const html = renderApplyControls(
            { id: 'm5', edits: [{ op: 'set' }], appliedAt: Date.now(), appliedTarget: 'preset' },
            { i18n: ident },
        );
        // The applied-line uses the to-form (carries the target token).
        expect(html).toContain('Applied to preset at');
        expect(html).not.toContain('Applied at');
    });

    it('translates appliedTarget through i18n before interpolating', () => {
        // Stored English keys like 'preset' / 'schema' / 'character'
        // should pass through the popup's i18n function so they surface
        // in the user's locale at render time. The popup's i18n maps
        // 'preset' → '预设' here; the renderer must apply that lookup
        // before threading the value into the "Applied to ${0} at ${1}"
        // template. (The popup's i18n also performs interpolation on
        // the template itself — we replicate that here so the test
        // exercises the same code path the real popups do.)
        const dict = { preset: '预设' };
        const i18n = (s, ...vals) => {
            const tpl = Object.hasOwn(dict, s) ? dict[s] : s;
            return vals.reduce((acc, v, i) => acc.replace(new RegExp('\\$\\{' + i + '\\}', 'g'), v), tpl);
        };
        const html = renderApplyControls(
            { id: 'm6', edits: [{ op: 'set' }], appliedAt: Date.now(), appliedTarget: 'preset' },
            { i18n },
        );
        expect(html).toContain('预设');
    });

    it('falls back to the plain "Applied at ${0}" form when no target is set', () => {
        // Without an appliedTarget, the renderer uses the bare form
        // (just a timestamp). Both message.js and apply.js must agree
        // on this fallback so the two journal surfaces look identical.
        const html = renderApplyControls(
            { id: 'm7', edits: [{ op: 'set' }], appliedAt: Date.now() },
            { i18n: ident },
        );
        // Single-arg form: "✓ Applied at HH:MM" — no "to X" segment.
        expect(html).not.toContain('Applied to');
        expect(html).toMatch(/Applied at/);
    });
});
