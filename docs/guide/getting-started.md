# Getting Started

This guide will help you get Luker up and running in minutes.

Luker runs on your own computer or phone. Pick the method that fits you — you only need the tools that method requires. Every method also needs a working LLM API (OpenAI, Claude, Google Gemini, local models, etc.).

## Standalone App

Run the complete Luker server and interface inside a single app. Opening it shows the full interface — there is no terminal and no browser address.

| Platform | How to get it | Requirements |
| --- | --- | --- |
| Desktop (macOS, Windows, Linux) | [Desktop App](/guide/desktop) | None |
| Android | [Android App](/guide/android) | None |
| iOS | [Self-signed IPA](/guide/ios) | A computer for the first AltStore or SideStore install |
| HarmonyOS | [Build from source](/guide/harmonyos) | Node.js >= 24.0, DevEco Studio |

iPhone and iPad install Luker as a self-signed app, outside the App Store.

## Docker

Best for server deployments or users who want an out-of-the-box experience. Luker provides pre-built Docker images. Requires Docker.

### 1. Create `docker-compose.yml`

Create a `docker-compose.yml` in the directory where you want to store data:

```yaml
services:
  luker:
    image: ghcr.io/funnycups/luker:latest
    container_name: luker
    ports:
      - 127.0.0.1:8000:8000
    volumes:
      - ./plugins:/home/node/app/plugins
      - ./config:/home/node/app/config
      - ./data:/home/node/app/data
      - ./extensions:/home/node/app/public/scripts/extensions/third-party
    restart: unless-stopped
```

### 2. Start the Container

```bash
docker compose up -d
```

::: warning Port Binding and Security
The default configuration binds the port to `127.0.0.1:8000`, allowing only local access. For remote access, change `127.0.0.1:8000:8000` to `0.0.0.0:8000:8000` and make sure to set up the following security measures:

- **Reverse Proxy + HTTPS**: Use a reverse proxy like Nginx to provide HTTPS encryption
- **Enable Authentication**: Turn on Basic Auth (`basicAuthMode: true`) or multi-user login (`enableUserAccounts: true`) to prevent unauthorized access. See [Configuration](/guide/configuration#authentication-and-multi-user) for details
:::

### 3. Update the Image

```bash
docker compose pull
docker compose up -d
```

## Git Clone

Best for users who want to manage and update manually. Requires Node.js >= 24.0 and Git.

### 1. Clone the Repository

```bash
git clone https://github.com/funnycups/Luker.git
cd Luker
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the Server

```bash
node server.js
```

You can also use the provided startup script, which automatically installs dependencies and starts the server:

```bash
bash start.sh
```

::: tip Alternative Runtimes
Luker also supports launching via Deno or Bun:
```bash
# Deno
npm run start:deno

# Bun
npm run start:bun
```
:::

### 4. Update

```bash
git pull
npm install
```

## Initial Setup

### Access Luker

Once the server is running, open your browser and navigate to:

```
http://localhost:8000
```

::: tip Standalone App Users
The Desktop, Android, and HarmonyOS apps display the full interface when opened — there is no URL to visit in a separate browser.
:::

### Configure API Connection

When you first enter Luker, you need to configure at least one LLM API to start chatting:

1. Click the **API Connection** icon at the top
2. Select your API type (e.g., OpenAI, Claude, etc.)
3. Enter the API endpoint and key
4. Test the connection

For detailed instructions, see [API Connections](/basics/connections).

### Select or Import a Character Card

Once the API is configured, you can:

- Select a character from the character card list to start chatting
- Click the **Import** button to import a `.png` or `.json` character card file

Learn more at [Character Cards](/basics/character-cards).

## Migrating from SillyTavern

Luker is fully compatible with SillyTavern data. If you're a SillyTavern user, you can simply copy the `data` directory into Luker. If you later decide to stop using Luker, you can downgrade back to SillyTavern at any time without data loss.

::: warning Backup Reminder
Although Luker is compatible with SillyTavern data, it's still recommended to back up before migrating.
:::

For a detailed migration guide, see [Migrating from SillyTavern](/guide/migration).

## Next Steps

- [Configure API Connections](/basics/connections) — Connect your LLM service
- [Learn about Character Cards](/basics/character-cards) — Start your first roleplay
- [Migrate from SillyTavern](/guide/migration) — If you're a SillyTavern user
- [Explore User Settings](/features/user-settings-additions) — Find the desktop data directory, backup, sync and storage tools
