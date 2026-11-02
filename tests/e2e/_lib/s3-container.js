// Ephemeral RustFS (S3-compatible) container for sync S3 tests.
// minio/minio and quay.io/minio/minio are not pullable from this
// environment's registries, so RustFS is the real S3 server used
// by unit, integration and e2e tests. RustFS honours If-Match /
// If-None-Match on PutObject with 412 PreconditionFailed, which
// the S3 backend's CAS requires. Pinned to RustFS 1.0.1
// (sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c)
// so a new `latest` cannot change S3 semantics under the tests.
import '../../../src/fetch-patch.js';

const ACCESS_KEY = 'luker-test';
const SECRET_KEY = 'luker-test-secret';

/**
 * @returns {Promise<{endpoint: string, accessKeyId: string, secretAccessKey: string, region: string, stop: () => Promise<void>}>}
 */
export async function startRustfsContainer() {
    // A normal-Node parent owns Docker for actual --jitless children: Docker's
    // SSH dependency initializes WASM even for a local Docker socket.
    if (process.env.LUKER_TEST_RUSTFS_ENDPOINT) {
        return {
            endpoint: process.env.LUKER_TEST_RUSTFS_ENDPOINT,
            accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: 'us-east-1',
            async stop() {},
        };
    }
    const { GenericContainer, Wait } = await import('testcontainers');
    const container = await new GenericContainer('rustfs/rustfs@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c')
        .withEnvironment({ RUSTFS_ACCESS_KEY: ACCESS_KEY, RUSTFS_SECRET_KEY: SECRET_KEY })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/', 9000).forStatusCode(403))
        // Cold pulls on CI hosts can take well over a minute.
        .withStartupTimeout(180_000)
        .start();
    return {
        endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        region: 'us-east-1',
        async stop() { await container.stop({ remove: true, removeVolumes: true }); },
    };
}
