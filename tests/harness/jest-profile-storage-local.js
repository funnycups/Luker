process.env.LUKER_TEST_PROFILE = 'storage-local';
// The local project owns filesystem and embedded-database backends. External
// backends are excluded before test modules evaluate their harness lists.
process.env.LUKER_DISABLE_MYSQL_TESTS = '1';
process.env.LUKER_DISABLE_POSTGRES_TESTS = '1';
