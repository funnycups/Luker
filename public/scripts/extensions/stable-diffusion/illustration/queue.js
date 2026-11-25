export class GenerationQueue {
    #maxConcurrent = 1;
    #minInterval = 0;
    #setTimeoutFn;
    #active = 0;
    #pending = [];
    #lastStartAt = 0;
    #timer = null;

    constructor({ maxConcurrent = 1, minInterval = 0, setTimeoutFn = globalThis.setTimeout } = {}) {
        this.#setTimeoutFn = setTimeoutFn;
        this.configure({ maxConcurrent, minInterval });
    }

    configure({ maxConcurrent, minInterval } = {}) {
        if (maxConcurrent !== undefined) {
            this.#maxConcurrent = Math.max(1, Math.round(Number(maxConcurrent) || 1));
        }
        if (minInterval !== undefined) {
            this.#minInterval = Math.max(0, Math.round(Number(minInterval) || 0));
        }
    }

    get activeCount() {
        return this.#active;
    }

    get pendingCount() {
        return this.#pending.length;
    }

    schedule(work, { signal } = {}) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                const error = new Error('Generation queue task aborted.');
                error.name = 'AbortError';
                reject(error);
                return;
            }
            const job = { work, resolve, reject, cleanup: null };
            if (signal && typeof signal.addEventListener === 'function') {
                const onAbort = () => {
                    const index = this.#pending.indexOf(job);
                    if (index !== -1) {
                        this.#pending.splice(index, 1);
                        const error = new Error('Generation queue task aborted.');
                        error.name = 'AbortError';
                        reject(error);
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
                job.cleanup = () => signal.removeEventListener('abort', onAbort);
            }
            this.#pending.push(job);
            this.#pump();
        });
    }

    #pump() {
        if (this.#timer !== null) {
            return;
        }
        while (this.#active < this.#maxConcurrent && this.#pending.length > 0) {
            const wait = this.#lastStartAt + this.#minInterval - Date.now();
            if (wait > 0) {
                this.#timer = this.#setTimeoutFn(() => {
                    this.#timer = null;
                    this.#pump();
                }, wait);
                return;
            }
            const job = this.#pending.shift();
            job.cleanup?.();
            this.#active += 1;
            this.#lastStartAt = Date.now();
            let output;
            try {
                output = job.work();
            } catch (error) {
                output = Promise.reject(error);
            }
            Promise.resolve(output)
                .then(job.resolve, job.reject)
                .finally(() => {
                    this.#active -= 1;
                    this.#pump();
                });
        }
    }
}
