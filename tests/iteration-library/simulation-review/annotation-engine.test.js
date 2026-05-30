/**
 * @jest-environment jsdom
 */
import { createAnnotationEngine } from '../../../public/scripts/iteration-library/simulation-review/annotation-engine.js';

function setupHost(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}

function selectTextInNode(node, start, end) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
}

afterEach(() => {
    document.body.innerHTML = '';
});

test('resolvePathForSelection walks up to nearest [data-loc-path]', () => {
    const host = setupHost(`
        <section data-loc-path="Final Output">
            <p>Hello <span id="target">world</span> here.</p>
        </section>
    `);
    const target = host.querySelector('#target').firstChild;
    selectTextInNode(target, 0, 5);
    const engine = createAnnotationEngine({ host });
    expect(engine.resolvePathForSelection(window.getSelection())).toBe('Final Output');
});

test('resolvePathForSelection returns "(unknown)" when no ancestor carries data-loc-path', () => {
    const host = setupHost('<p id="t">no path</p>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 0, 2);
    const engine = createAnnotationEngine({ host });
    expect(engine.resolvePathForSelection(window.getSelection())).toBe('(unknown)');
});

test('addAnnotation wraps selection in <mark> and emits change with new id', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const changes = [];
    const engine = createAnnotationEngine({ host, onStateChange: (state) => changes.push(state.size) });
    const created = engine.addAnnotationFromSelection(window.getSelection(), 'feels weak');
    expect(created.id).toBe(1);
    expect(created.snippet).toBe('bar');
    expect(created.comment).toBe('feels weak');
    expect(created.path).toBe('A');
    expect(host.querySelector('mark.luker-sim-annotation')).not.toBeNull();
    expect(host.querySelector('mark.luker-sim-annotation').getAttribute('data-ann-id')).toBe('1');
    expect(changes).toEqual([1]);
});

test('addAnnotation rejects empty selections', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">x</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 0, 0);
    const engine = createAnnotationEngine({ host });
    expect(() => engine.addAnnotationFromSelection(window.getSelection(), 'note')).toThrow(/empty/i);
});

test('deleteAnnotation unwraps the mark and reissues ids sequentially', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 0, 3);
    const engine = createAnnotationEngine({ host });
    const ann = engine.addAnnotationFromSelection(window.getSelection(), 'note');
    expect(engine.getAnnotations()).toHaveLength(1);
    engine.deleteAnnotation(ann.id);
    expect(engine.getAnnotations()).toHaveLength(0);
    expect(host.querySelector('mark.luker-sim-annotation')).toBeNull();
});

test('editAnnotation updates the comment without changing snippet', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 0, 3);
    const engine = createAnnotationEngine({ host });
    const ann = engine.addAnnotationFromSelection(window.getSelection(), 'first');
    engine.editAnnotation(ann.id, 'second');
    expect(engine.getAnnotations()[0].comment).toBe('second');
    expect(engine.getAnnotations()[0].snippet).toBe('foo');
});

test('buildChainSegments rebuilds segment list from current DOM', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host });
    engine.addAnnotationFromSelection(window.getSelection(), 'note');
    const segs = engine.buildChainSegments();
    expect(segs.length).toBe(3);
    expect(segs[0].text).toBe('foo ');
    expect(segs[0].annotationId).toBeUndefined();
    expect(segs[1].text).toBe('bar');
    expect(segs[1].annotationId).toBe(1);
    expect(segs[2].text).toBe(' baz');
});

test('onAnnotationCreated fires with the summary + mark element', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const events = [];
    const engine = createAnnotationEngine({
        host,
        onAnnotationCreated: (ann, mark) => events.push({ ann, mark }),
    });
    engine.addAnnotationFromSelection(window.getSelection(), 'note');
    expect(events).toHaveLength(1);
    expect(events[0].ann.id).toBe(1);
    expect(events[0].ann.snippet).toBe('bar');
    expect(events[0].ann.comment).toBe('note');
    expect(events[0].ann.path).toBe('A');
    expect(events[0].mark instanceof HTMLElement).toBe(true);
    expect(events[0].mark.tagName).toBe('MARK');
});

test('onAnnotationDeleted fires with the id', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 0, 3);
    const events = [];
    const engine = createAnnotationEngine({
        host,
        onAnnotationDeleted: (id) => events.push(id),
    });
    const ann = engine.addAnnotationFromSelection(window.getSelection(), 'x');
    engine.deleteAnnotation(ann.id);
    expect(events).toEqual([ann.id]);
});

test('cross-element selection throws friendly error instead of raw DOMException', () => {
    const host = setupHost('<section data-loc-path="A"><p id="a">one</p><p id="b">two</p></section>');
    const range = document.createRange();
    range.setStart(host.querySelector('#a').firstChild, 1);
    range.setEnd(host.querySelector('#b').firstChild, 2);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const engine = createAnnotationEngine({ host });
    expect(() => engine.addAnnotationFromSelection(window.getSelection(), 'x'))
        .toThrow(/crosses element boundaries/i);
});

test('addAnnotation inserts an inline × control inside the <mark>', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({
        host,
        i18n: (k, fb) => fb,
    });
    engine.addAnnotationFromSelection(window.getSelection(), '');
    const mark = host.querySelector('mark.luker-sim-annotation');
    expect(mark).not.toBeNull();
    const removeBtn = mark.querySelector('.sim-review-annot-remove');
    expect(removeBtn).not.toBeNull();
    expect(removeBtn.tagName).toBe('BUTTON');
    expect(removeBtn.textContent).toBe('×');
    // ARIA label flows through i18n so screen readers get localized text.
    expect(removeBtn.getAttribute('aria-label')).toBe('Remove annotation');
});

test('clicking the inline × deletes the annotation: state empties, mark unwraps, chain has no annotationId', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host, i18n: (k, fb) => fb });
    const ann = engine.addAnnotationFromSelection(window.getSelection(), '');
    expect(engine.getAnnotations()).toHaveLength(1);
    const mark = host.querySelector(`mark[data-ann-id="${ann.id}"]`);
    const removeBtn = mark.querySelector('.sim-review-annot-remove');
    removeBtn.click();
    expect(engine.getAnnotations()).toHaveLength(0);
    expect(host.querySelector('mark.luker-sim-annotation')).toBeNull();
    // The chain rebuilt from the (now-unwrapped) DOM must NOT include
    // the literal "×" glyph — the engine strips the remove button
    // before unwrapping.
    const segments = engine.buildChainSegments();
    const joined = segments.map(s => s.text).join('');
    expect(joined).toBe('foo bar baz');
    expect(segments.every(s => s.annotationId == null)).toBe(true);
});

test('buildChainSegments ignores the × control inside an active <mark>', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host, i18n: (k, fb) => fb });
    engine.addAnnotationFromSelection(window.getSelection(), '');
    // The mark still contains the × control as a child, but the chain
    // segments must reflect the user's original text only.
    const segments = engine.buildChainSegments();
    const joined = segments.map(s => s.text).join('');
    expect(joined).toBe('foo bar baz');
});

test('addAnnotation inserts an inline comment <input> next to the × control', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host, i18n: (k, fb) => fb });
    engine.addAnnotationFromSelection(window.getSelection(), '');
    const mark = host.querySelector('mark.luker-sim-annotation');
    expect(mark).not.toBeNull();
    const input = mark.querySelector('input.sim-review-annot-comment');
    expect(input).not.toBeNull();
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('text');
    // Placeholder flows through i18n so non-English locales get translated text.
    expect(input.placeholder).toBe('Comment (optional)');
});

test('addAnnotation pre-fills the inline input with the seed comment value', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host, i18n: (k, fb) => fb });
    engine.addAnnotationFromSelection(window.getSelection(), 'seed comment');
    const input = host.querySelector('mark.luker-sim-annotation input.sim-review-annot-comment');
    expect(input).not.toBeNull();
    expect(input.value).toBe('seed comment');
});

test('typing into the inline input live-updates the annotation comment', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host, i18n: (k, fb) => fb });
    const ann = engine.addAnnotationFromSelection(window.getSelection(), '');
    const input = host.querySelector('mark.luker-sim-annotation input.sim-review-annot-comment');
    expect(input).not.toBeNull();
    input.value = 'feels weak here';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const stored = engine.getAnnotations().find(a => a.id === ann.id);
    expect(stored).toBeDefined();
    expect(stored.comment).toBe('feels weak here');
});

test('inline input text does NOT leak into buildChainSegments output', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host, i18n: (k, fb) => fb });
    engine.addAnnotationFromSelection(window.getSelection(), '');
    const input = host.querySelector('mark.luker-sim-annotation input.sim-review-annot-comment');
    // Type something that would be unique and easy to spot if it leaked.
    input.value = 'XXXLEAKXXX';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const segments = engine.buildChainSegments();
    const joined = segments.map(s => s.text).join('');
    expect(joined).toBe('foo bar baz');
    expect(joined).not.toContain('XXXLEAKXXX');
});

test('deleteAnnotation strips the inline comment input as well as the × control', () => {
    const host = setupHost('<section data-loc-path="A"><p id="t">foo bar baz</p></section>');
    const target = host.querySelector('#t').firstChild;
    selectTextInNode(target, 4, 7); // "bar"
    const engine = createAnnotationEngine({ host, i18n: (k, fb) => fb });
    const ann = engine.addAnnotationFromSelection(window.getSelection(), '');
    expect(host.querySelector('input.sim-review-annot-comment')).not.toBeNull();
    const mark = host.querySelector(`mark[data-ann-id="${ann.id}"]`);
    const removeBtn = mark.querySelector('.sim-review-annot-remove');
    removeBtn.click();
    expect(host.querySelector('input.sim-review-annot-comment')).toBeNull();
    // And the surrounding chain text remains clean.
    const segments = engine.buildChainSegments();
    const joined = segments.map(s => s.text).join('');
    expect(joined).toBe('foo bar baz');
});
