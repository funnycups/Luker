import net from 'node:net';
import { EventEmitter } from 'node:events';
import yaml from 'yaml';
import { describe, expect, test } from '@jest/globals';
import {
    pickPort,
    probePort,
    readCliPort,
    resolveStartupListenPlan,
} from '../desktop-app/startup-config.js';

describe('desktop startup port and listen configuration', () => {
    test('readCliPort returns null when --port is absent and parses valid ports', () => {
        expect(readCliPort(['electron', '.'])).toBeNull();
        expect(readCliPort(['electron', '.', '--port=0'])).toBeNull();
        expect(readCliPort(['electron', '.', '--port=70000'])).toBeNull();
        expect(readCliPort(['electron', '.', '--port=9123'])).toBe(9123);
    });

    test('resolveStartupListenPlan honors config.yaml port when CLI port is absent and lets CLI override', () => {
        const configText = [
            'port: 9456',
            'listen: false',
            'protocol:',
            '  ipv4: true',
            '  ipv6: false',
        ].join('\n');

        const fromConfig = resolveStartupListenPlan({
            cliPort: null,
            configText,
            parseYaml: yaml.parse,
        });
        expect(fromConfig.preferredPort).toBe(9456);
        expect(fromConfig.configPort).toBe(9456);
        expect(fromConfig.probeTargets).toEqual([
            { host: '127.0.0.1', ipv6Only: false, optional: false },
        ]);

        const fromCli = resolveStartupListenPlan({
            cliPort: 8111,
            configText,
            parseYaml: yaml.parse,
        });
        expect(fromCli.preferredPort).toBe(8111);
        expect(fromCli.configPort).toBe(9456);
    });

    test('resolveStartupListenPlan includes wildcard and IPv6 targets when configured', () => {
        const configText = [
            'port: 8000',
            'listen: true',
            'listenAddress:',
            '  ipv4: 0.0.0.0',
            '  ipv6: \'[::]\'',
            'protocol:',
            '  ipv4: true',
            '  ipv6: true',
        ].join('\n');

        const plan = resolveStartupListenPlan({
            cliPort: null,
            configText,
            parseYaml: yaml.parse,
        });
        expect(plan.probeTargets).toEqual([
            { host: '127.0.0.1', ipv6Only: false, optional: false },
            { host: '0.0.0.0', ipv6Only: false, optional: false },
            { host: '::', ipv6Only: true, optional: false },
        ]);
    });

    test('resolveStartupListenPlan degrades cleanly when config.yaml has invalid syntax so backend reports it', () => {
        const plan = resolveStartupListenPlan({
            cliPort: null,
            configText: 'storage: [\n',
            parseYaml: yaml.parse,
        });
        expect(plan.configValid).toBe(false);
        expect(plan.preferredPort).toBe(8000);
    });

    test('probePort treats both EADDRINUSE and Windows EACCES reserved ports as unavailable', async () => {
        const makeErrorServer = (code) => () => {
            const emitter = new EventEmitter();
            emitter.listen = () => {
                const err = new Error(code);
                err.code = code;
                queueMicrotask(() => emitter.emit('error', err));
            };
            emitter.close = (cb) => cb?.();
            return emitter;
        };

        expect(await probePort(8000, [{ host: '127.0.0.1', ipv6Only: false, optional: false }], {
            createServer: makeErrorServer('EADDRINUSE'),
        })).toBe(false);

        expect(await probePort(8000, [{ host: '127.0.0.1', ipv6Only: false, optional: false }], {
            createServer: makeErrorServer('EACCES'),
        })).toBe(false);
    });

    test('pickPort steps past EACCES reserved ports to the next free port', async () => {
        const realServer = net.createServer;
        const chosen = await pickPort(19800, {
            probeTargets: [{ host: '127.0.0.1', ipv6Only: false, optional: false }],
            createServer: () => {
                const inner = realServer();
                const origListen = inner.listen.bind(inner);
                inner.listen = (opts, cb) => {
                    if (opts.port === 19800) {
                        const err = new Error('listen EACCES: permission denied');
                        err.code = 'EACCES';
                        queueMicrotask(() => inner.emit('error', err));
                        return inner;
                    }
                    return origListen(opts, cb);
                };
                return inner;
            },
        });
        expect(chosen).toBeGreaterThanOrEqual(19801);
    });
});
