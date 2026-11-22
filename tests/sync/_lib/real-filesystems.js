import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SYSTEM_BIN_PATH = [process.env.PATH, '/usr/sbin', '/sbin'].filter(Boolean).join(path.delimiter);

function probeFilesystemSemantics(root, manifest, semantics, save) {
    manifest.observations = [];
    for (const [label, a, b] of [['case', 'A.png', 'a.png'], ['normalization', '\u00e9.png', 'e\u0301.png']]) {
        const dir = path.join(root, label);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, a), 'a', { flag: 'wx' });
        let alias = false;
        try {
            fs.writeFileSync(path.join(dir, b), 'b', { flag: 'wx' });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            alias = true;
        }
        const first = fs.statSync(path.join(dir, a), { bigint: true });
        const second = fs.statSync(path.join(dir, b), { bigint: true });
        manifest.observations.push({
            label,
            a,
            b,
            alias,
            sameObject: first.dev === second.dev && first.ino === second.ino,
            names: fs.readdirSync(dir, { encoding: 'buffer' }).map(name => name.toString('hex')),
        });
    }
    save();
    if (manifest.observations[0].alias !== (semantics === 'case-insensitive')) {
        throw new Error(`BLOCKED: native case fixture semantics do not match ${semantics}; evidence ${manifest.owned}`);
    }
    if (semantics === 'case-insensitive' && !manifest.observations[1].alias) {
        throw new Error(`BLOCKED: native normalization fixture semantics do not alias for ${semantics}; evidence ${manifest.owned}`);
    }
}

function unescapeProcMountPath(field) {
    return field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function isLinuxMountActive(mountpoint) {
    const resolved = fs.existsSync(mountpoint) ? fs.realpathSync(mountpoint) : path.resolve(mountpoint);
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(Boolean);
    return mounts.some(line => {
        const fields = line.split(' ');
        return fields.length >= 2 && unescapeProcMountPath(fields[1]) === resolved;
    });
}

/** A genuine owned volume; capability failures block its consuming gate. */
export async function createRealFilesystemFixture({ parent = os.tmpdir(), semantics, artifactDir }) {
    if (process.env.LUKER_DISABLE_NATIVE_FS_TESTS) {
        throw new Error('BLOCKED: required native filesystem fixture is disabled by LUKER_DISABLE_NATIVE_FS_TESTS');
    }
    const owned = fs.mkdtempSync(path.join(parent, 'luker-sync-native-'));
    const manifest = { pid: process.pid, platform: process.platform, owned, semantics, commands: [] };
    const save = () => {
        fs.writeFileSync(path.join(owned, 'manifest.json'), JSON.stringify(manifest, null, 2));
        if (artifactDir) {
            fs.mkdirSync(artifactDir, { recursive: true });
            fs.writeFileSync(path.join(artifactDir, `${path.basename(owned)}.json`), JSON.stringify(manifest, null, 2));
        }
    };
    const run = (command, args, input) => {
        const result = spawnSync(command, args, {
            input,
            encoding: 'utf8',
            env: { ...process.env, PATH: SYSTEM_BIN_PATH },
        });
        manifest.commands.push({
            command,
            args,
            code: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.error?.message,
        });
        save();
        if (result.error || result.status !== 0) {
            const label = command === 'sudo' ? `sudo ${args[1] ?? ''}` : `${command} ${args[0] ?? ''}`;
            throw new Error(`BLOCKED: required native filesystem ${label.trim()} failed; evidence ${owned}: ${result.error?.message || result.stderr}`);
        }
        return result.stdout;
    };

    if (process.platform === 'darwin') {
        const image = path.join(owned, 'fixture.sparseimage');
        const root = path.join(owned, 'mount');
        fs.mkdirSync(root);
        manifest.image = image;
        manifest.root = root;
        const jsonPlist = text => JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '--', '-'], text));
        const cleanup = async ({ retain = false } = {}) => {
            if (manifest.device && !manifest.detached) {
                run('hdiutil', ['detach', manifest.device]);
                const info = jsonPlist(run('hdiutil', ['info', '-plist']));
                if (info.images.some(entry => entry['image-path'] === image)) {
                    throw new Error(`BLOCKED: owned native image is still attached: ${image}`);
                }
                manifest.detached = true;
                save();
            }
            if (!retain) {
                if (fs.existsSync(image)) fs.unlinkSync(image);
                if (fs.existsSync(root)) fs.rmdirSync(root);
                if (fs.existsSync(path.join(owned, 'manifest.json'))) fs.unlinkSync(path.join(owned, 'manifest.json'));
                if (fs.existsSync(owned)) fs.rmdirSync(owned);
            }
        };
        save();
        try {
            const format = semantics === 'case-sensitive' ? 'Case-sensitive APFS' : 'APFS';
            run('hdiutil', ['create', '-type', 'SPARSE', '-size', '256m', '-fs', format, '-volname', 'SyncIdentityFixture', image]);
            const attached = jsonPlist(run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', root, '-plist', image]));
            manifest.device = attached['system-entities'].find(entry => entry['dev-entry'])?.['dev-entry'];
            if (!manifest.device) throw new Error(`BLOCKED: native attach did not return an owned device: ${owned}`);
            probeFilesystemSemantics(root, manifest, semantics, save);
            return { root, observations: manifest.observations, cleanup };
        } catch (error) {
            manifest.failure = error.message;
            save();
            try {
                await cleanup({ retain: true });
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], `Native fixture setup and cleanup failed: ${owned}`);
            }
            throw error;
        }
    }

    if (process.platform === 'linux') {
        const runPrivileged = (command, args) => (
            typeof process.getuid === 'function' && process.getuid() === 0
                ? run(command, args)
                : run('sudo', ['-n', command, ...args])
        );

        if (semantics === 'case-sensitive') {
            const root = path.join(owned, 'root');
            fs.mkdirSync(root);
            manifest.root = root;
            save();
            const cleanup = async ({ retain = false } = {}) => {
                if (!retain) fs.rmSync(owned, { recursive: true, force: true });
            };
            try {
                probeFilesystemSemantics(root, manifest, semantics, save);
                return { root, observations: manifest.observations, cleanup };
            } catch (error) {
                manifest.failure = error.message;
                save();
                throw error;
            }
        }

        const image = path.join(owned, 'fixture.img');
        const mountpoint = path.join(owned, 'mount');
        const root = path.join(mountpoint, 'root');
        fs.mkdirSync(mountpoint);
        manifest.image = image;
        manifest.mountpoint = mountpoint;
        manifest.root = root;
        const cleanup = async ({ retain = false } = {}) => {
            if (manifest.mounted && !manifest.detached) {
                runPrivileged('umount', [mountpoint]);
                if (isLinuxMountActive(mountpoint)) {
                    throw new Error(`BLOCKED: owned native image is still mounted: ${mountpoint}`);
                }
                manifest.detached = true;
                save();
            }
            if (!retain) {
                fs.rmSync(owned, { recursive: true, force: true });
            }
        };
        save();
        try {
            // 256 MiB sparse ext4 image (matching macOS 256m and providing 65,536 inodes)
            // with UTF-8 casefold; chattr +F applies to an empty subdirectory because
            // mkfs.ext4 populates the mount root with lost+found.
            fs.closeSync(fs.openSync(image, 'w'));
            fs.truncateSync(image, 256 * 1024 * 1024);
            run('mkfs.ext4', ['-q', '-F', '-b', '4096', '-O', 'casefold', '-E', 'encoding=utf8', image]);
            runPrivileged('mount', ['-o', 'loop', image, mountpoint]);
            manifest.mounted = true;
            save();
            runPrivileged('mkdir', ['-p', root]);
            runPrivileged('chattr', ['+F', root]);
            if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
                runPrivileged('chown', [`${process.getuid()}:${process.getgid()}`, root]);
            }
            probeFilesystemSemantics(root, manifest, semantics, save);
            return { root, observations: manifest.observations, cleanup };
        } catch (error) {
            manifest.failure = error.message;
            save();
            try {
                await cleanup({ retain: true });
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], `Native fixture setup and cleanup failed: ${owned}`);
            }
            throw error;
        }
    }

    manifest.failure = `Unsupported platform: ${process.platform}`;
    save();
    throw new Error(`BLOCKED: required native filesystem fixture is unsupported on ${process.platform}; evidence ${owned}`);
}
