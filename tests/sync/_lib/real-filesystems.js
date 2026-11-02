import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A genuine owned volume; capability failures block its consuming gate. */
export async function createRealFilesystemFixture({ parent = os.tmpdir(), semantics, artifactDir }) {
    if (process.env.LUKER_DISABLE_NATIVE_FS_TESTS) throw new Error('BLOCKED: required native filesystem fixture is disabled by LUKER_DISABLE_NATIVE_FS_TESTS');
    const owned = fs.mkdtempSync(path.join(parent, 'luker-sync-native-'));
    const image = path.join(owned, 'fixture.sparseimage');
    const root = path.join(owned, 'mount');
    fs.mkdirSync(root);
    const manifest = { pid: process.pid, owned, image, root, semantics, commands: [] };
    const save = () => {
        fs.writeFileSync(path.join(owned, 'manifest.json'), JSON.stringify(manifest, null, 2));
        if (artifactDir) {
            fs.mkdirSync(artifactDir, { recursive: true });
            fs.writeFileSync(path.join(artifactDir, `${path.basename(owned)}.json`), JSON.stringify(manifest, null, 2));
        }
    };
    const run = (command, args, input) => {
        const result = spawnSync(command, args, { input, encoding: 'utf8' });
        manifest.commands.push({ command, args, code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
        save();
        if (result.error || result.status !== 0) throw new Error(`BLOCKED: required native filesystem ${command} ${args[0]} failed; evidence ${owned}: ${result.error?.message || result.stderr}`);
        return result.stdout;
    };
    const jsonPlist = text => JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '--', '-'], text));
    const cleanup = async ({ retain = false } = {}) => {
        if (manifest.device && !manifest.detached) {
            run('hdiutil', ['detach', manifest.device]);
            const info = jsonPlist(run('hdiutil', ['info', '-plist']));
            if (info.images.some(entry => entry['image-path'] === image)) throw new Error(`BLOCKED: owned native image is still attached: ${image}`);
            manifest.detached = true;
            save();
        }
        if (!retain) {
            fs.unlinkSync(image);
            fs.rmdirSync(root);
            fs.unlinkSync(path.join(owned, 'manifest.json'));
            fs.rmdirSync(owned);
        }
    };
    save();
    try {
        const format = semantics === 'case-sensitive' ? 'Case-sensitive APFS' : 'APFS';
        run('hdiutil', ['create', '-type', 'SPARSE', '-size', '256m', '-fs', format, '-volname', 'SyncIdentityFixture', image]);
        const attached = jsonPlist(run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', root, '-plist', image]));
        manifest.device = attached['system-entities'].find(entry => entry['dev-entry'])?.['dev-entry'];
        if (!manifest.device) throw new Error(`BLOCKED: native attach did not return an owned device: ${owned}`);
        manifest.observations = [];
        for (const [label, a, b] of [['case', 'A.png', 'a.png'], ['normalization', '\u00e9.png', 'e\u0301.png']]) {
            const dir = path.join(root, label);
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, a), 'a', { flag: 'wx' });
            let alias = false;
            try { fs.writeFileSync(path.join(dir, b), 'b', { flag: 'wx' }); } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                alias = true;
            }
            const first = fs.statSync(path.join(dir, a), { bigint: true });
            const second = fs.statSync(path.join(dir, b), { bigint: true });
            manifest.observations.push({ label, a, b, alias, sameObject: first.dev === second.dev && first.ino === second.ino, names: fs.readdirSync(dir, { encoding: 'buffer' }).map(name => name.toString('hex')) });
        }
        save();
        if (manifest.observations[0].alias !== (semantics === 'case-insensitive')) throw new Error(`BLOCKED: native case fixture semantics do not match ${semantics}; evidence ${owned}`);
        return { root, observations: manifest.observations, cleanup };
    } catch (error) {
        manifest.failure = error.message;
        save();
        try { await cleanup({ retain: true }); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `Native fixture setup and cleanup failed: ${owned}`); }
        throw error;
    }
}
