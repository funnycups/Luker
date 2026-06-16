import { FsEngine } from './engines/fs-engine.js';
import { SqliteEngine } from './engines/sqlite-engine.js';
import { MysqlEngine } from './engines/mysql-engine.js';
import { PgEngine } from './engines/postgres-engine.js';
import { ChatRepo } from './repositories/chat-repo.js';
import { SettingsRepo } from './repositories/settings-repo.js';
import { PresetRepo } from './repositories/preset-repo.js';
import { WorldInfoRepo } from './repositories/world-info-repo.js';
import { NamedDocRepo } from './repositories/named-doc-repo.js';
import { GroupRepo } from './repositories/group-repo.js';
import { StatsRepo } from './repositories/stats-repo.js';

export { setReadOnly, isReadOnly, withReadOnlyBypass } from './read-only-mode.js';

let _engine = null;
let _chatRepo = null;
let _settingsRepo = null;
let _presetRepo = null;
let _worldInfoRepo = null;
let _namedDocRepo = null;
let _groupRepo = null;
let _statsRepo = null;

export function initStorage({ mode = 'fs', directoriesByHandle, mysql, postgres } = {}) {
    if (mode === 'fs') {
        _engine = new FsEngine({ directoriesByHandle });
    } else if (mode === 'sqlite') {
        _engine = new SqliteEngine({ directoriesByHandle });
    } else if (mode === 'mysql') {
        if (!mysql || typeof mysql.url !== 'string' || !mysql.url) {
            throw new Error('initStorage: mode=mysql requires storage.mysql.url in config');
        }
        _engine = new MysqlEngine({ url: mysql.url, poolSize: mysql.poolSize });
    } else if (mode === 'postgres') {
        if (!postgres || typeof postgres.url !== 'string' || !postgres.url) {
            throw new Error('initStorage: mode=postgres requires storage.postgres.url in config');
        }
        _engine = new PgEngine({ url: postgres.url, poolSize: postgres.poolSize });
    } else {
        throw new Error(`initStorage: unknown storage mode "${mode}" (expected 'fs', 'sqlite', 'mysql', or 'postgres')`);
    }
    _chatRepo = new ChatRepo({ engine: _engine });
    _settingsRepo = new SettingsRepo({ engine: _engine });
    _presetRepo = new PresetRepo({ engine: _engine });
    _worldInfoRepo = new WorldInfoRepo({ engine: _engine });
    _namedDocRepo = new NamedDocRepo({ engine: _engine });
    _groupRepo = new GroupRepo({ engine: _engine });
    _statsRepo = new StatsRepo({ engine: _engine });
}

export function getChatRepo() {
    if (!_chatRepo) throw new Error('storage not initialized; call initStorage() first');
    return _chatRepo;
}

export function getSettingsRepo() {
    if (!_settingsRepo) throw new Error('storage not initialized; call initStorage() first');
    return _settingsRepo;
}

export function getPresetRepo() {
    if (!_presetRepo) throw new Error('storage not initialized; call initStorage() first');
    return _presetRepo;
}

export function getWorldInfoRepo() {
    if (!_worldInfoRepo) throw new Error('storage not initialized; call initStorage() first');
    return _worldInfoRepo;
}

export function getNamedDocRepo() {
    if (!_namedDocRepo) throw new Error('storage not initialized; call initStorage() first');
    return _namedDocRepo;
}

export function getGroupRepo() {
    if (!_groupRepo) throw new Error('storage not initialized; call initStorage() first');
    return _groupRepo;
}

export function getStatsRepo() {
    if (!_statsRepo) throw new Error('storage not initialized; call initStorage() first');
    return _statsRepo;
}

export function getStorageEngine() {
    if (!_engine) throw new Error('storage not initialized; call initStorage() first');
    return _engine;
}
