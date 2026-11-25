import { serializeFailure } from '../resources/errors.js';

// Output evidence from the existing native runner; this reporter owns no lifecycle.
export default async function* report(events) {
    for await (const event of events) {
        const data = { ...event.data };
        if (data.details) {
            data.details = { ...data.details };
            if (data.details.error !== undefined) data.details.error = serializeFailure(data.details.error);
        }
        yield `${JSON.stringify({ type: event.type, data })}\n`;
    }
}
