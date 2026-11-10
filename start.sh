#!/usr/bin/env bash

# Make sure pwd is the directory of the script
cd "$(dirname "$0")"

if ! command -v npm &> /dev/null
then
    echo -e "\033[0;31mnpm could not be found in PATH. If the startup fails, please install Node.js from https://nodejs.org/\033[0m"
fi

echo "Installing Node Modules..."
export NODE_ENV=production
npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts

# npm install scripts stay disabled in this repository, so the native SQLite
# binding is built explicitly. Android has no prebuilt binary, so it stays
# opt-in there: run `npm run storage:install-sqlite` when the SQLite backend is
# needed. File storage works without the binding.
if [ ! -f "node_modules/better-sqlite3/build/Release/better_sqlite3.node" ] \
    && [ "$(node -p 'process.platform')" != "android" ]; then
    echo "Installing the SQLite storage dependency..."
    npm run storage:install-sqlite
fi

echo "Entering SillyTavern..."
node "server.js" "$@"
