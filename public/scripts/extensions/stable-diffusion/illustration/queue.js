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

    schedule(work) {
        return new Promise((resolve, reject) => {
            this.#pending.push({ work, resolve, reject });
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
