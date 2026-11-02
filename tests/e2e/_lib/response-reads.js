/** Own body reads immediately and report every failure at awaited settlement. */
export function createResponseReadOwner() {
    const reads = [];
    const texts = [];
    return {
        observe(response) {
            reads.push(Promise.resolve().then(() => response.text()).then(text => { texts.push(text); return { text }; }, error => ({ error })));
        },
        get texts() { return [...texts]; },
        async settle(primary) {
            const results = await Promise.all(reads);
            const failures = [...(primary ? [primary] : []), ...results.filter(result => result.error).map(result => result.error)];
            if (failures.length) throw new globalThis.AggregateError(failures, 'Owned response reads did not settle successfully');
            return results.map(result => result.text);
        },
    };
}
