@echo off
pushd %~dp0
set NODE_ENV=production
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
if not exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" call npm run storage:install-sqlite
node server.js %*
pause
popd
