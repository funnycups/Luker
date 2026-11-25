process.env.LUKER_TEST_PROFILE = 'unit';
// Unit tests never own an external database lease. Files that allocate a
// storage harness get a managed filesystem or embedded-database scope; SQL
// backends run only in the storage-sql project.
process.env.LUKER_DISABLE_MYSQL_TESTS = '1';
process.env.LUKER_DISABLE_POSTGRES_TESTS = '1';
