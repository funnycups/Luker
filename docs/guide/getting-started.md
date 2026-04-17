# Getting Started

This guide will help you get Luker up and running in minutes.

## Prerequisites

| Dependency | Requirement |
| --- | --- |
| **Node.js** | >= 20.0 (Git Clone method only) |
| **Git** | Any version (Git Clone method only) |
| **Docker** | Any modern version (Docker method only) |

You'll also need a working LLM API (OpenAI, Claude, Google Gemini, local models, etc.).

## Method 1: Git Clone

Best for users who want to manage and update manually.

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

## Method 2: Docker

Best for server deployments or users who want an out-of-the-box experience. Luker provides pre-built Docker images.

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

## Method 3: Android APK

Luker provides an Android app that lets you run Luker directly on your phone without relying on a cloud server or Termux.

Download the latest APK from the GitHub Releases page:

👉 [https://github.com/funnycups/Luker/releases/latest](https://github.com/funnycups/Luker/releases/latest)

Download and install the APK, then open the app to start using it right away.

## Initial Setup

### Access Luker

Once the server is running, open your browser and navigate to:

```
http://localhost:8000
```

::: tip Android Users
The APK version is a standalone app — it displays the full interface when opened, no need to visit a URL in a separate browser.
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
