# ⚡ FileHost — Temporary File Hosting on Vercel

A Telegram bot + web UI for temporary file hosting. Files are automatically deleted after your chosen duration (10 minutes to 24 hours).

## Architecture

```
Telegram Bot (webhook) ──► /api/telegram.js ──► Vercel Blob (file storage)
Web UI (index.html)    ──► /api/upload.js   ──► Vercel Blob (file storage)
                                                      │
                           /api/cleanup.js ◄── Cron (hourly)
                           Vercel KV ← metadata + expiry tracking
```

### Why this stack?
| Concern | Solution | Free tier |
|---|---|---|
| File storage | Vercel Blob | 500MB / 1GB bandwidth |
| Metadata + expiry | Vercel KV (Redis) | 256MB |
| Scheduled cleanup | Vercel Cron | 1 job (hobby) |
| Telegram | Webhook (not polling) | Free |

---

## Setup Guide

### 1. Create a Telegram Bot

1. Open Telegram → search **@BotFather**
2. Send `/newbot`
3. Follow the prompts; copy your **bot token**
4. Optionally set a description: `/setdescription`

### 2. Clone & Deploy to Vercel

```bash
# Fork / clone this repo
git clone https://github.com/YOUR_USERNAME/filehost
cd filehost

# Install Vercel CLI
npm i -g vercel

# Login and deploy
vercel login
vercel deploy
```

### 3. Add Vercel Storage

In the [Vercel Dashboard](https://vercel.com/dashboard):

#### Vercel Blob
1. Go to your project → **Storage** tab
2. Click **Create** → **Blob**
3. Name it (e.g. `filehost-blob`) → **Create**
4. It will auto-inject `BLOB_READ_WRITE_TOKEN` into your project

#### Vercel KV (Redis)
1. **Storage** → **Create** → **KV**
2. Name it (e.g. `filehost-kv`) → **Create**
3. It will auto-inject `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`

### 4. Set Environment Variables

In Vercel Dashboard → your project → **Settings** → **Environment Variables**:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your bot token from BotFather |
| `BASE_URL` | `https://your-project.vercel.app` |
| `SETUP_SECRET` | Any random string (e.g. `openssl rand -hex 16`) |
| `CRON_SECRET` | Any random string |

> Vercel Blob and KV tokens are auto-injected when you link storage in the dashboard.

### 5. Deploy with env vars

```bash
vercel deploy --prod
```

### 6. Register the Telegram Webhook

Visit this URL in your browser (one time only):

```
https://your-project.vercel.app/api/setup?secret=YOUR_SETUP_SECRET
```

You should see a JSON response confirming the webhook is set. ✅

### 7. Update the Telegram bot link in the web UI

In `public/index.html`, find this line:

```html
<a class="tg-btn" id="tgBotLink" href="https://t.me/YourBotUsername" target="_blank">
```

Replace `YourBotUsername` with your actual bot username (without the `@`).

---

## Usage

### Telegram Bot

| Action | How |
|---|---|
| Upload a file | Send any file (document, photo, video, audio) |
| Upload from URL | Send a direct `https://` link |
| Choose expiry | Tap one of the time buttons that appear |
| Get link | Bot replies with the Vercel Blob URL |

**Commands:**
- `/start` — Welcome + instructions
- `/help` — Help message
- `/web` — Get the web UI link

**Limits via Telegram:**
- Max file size: **50MB** (Telegram bot API limit)
- Bot can download from any public URL

### Web UI

1. Open `https://your-project.vercel.app`
2. Drop a file or paste a URL
3. Choose expiry duration
4. Click Upload
5. Copy & share the link

**Limits via Web:**
- Max file size: **4.5MB** (Vercel serverless body limit)
- For larger files, use the Telegram bot

---

## File Expiry & Cleanup

- Files are stored in **Vercel Blob** with metadata in **Vercel KV**
- A **cron job** runs every hour (`/api/cleanup`) to delete expired files
- Expiry is tracked via a Redis sorted set (`files_by_expiry`) scored by Unix timestamp
- On the hobby plan, Vercel allows **1 cron job** — we use it for cleanup

---

## Vercel Free Tier Limits

| Resource | Free Limit | Our Usage |
|---|---|---|
| Serverless function duration | 10s (hobby) | Upload: ~5-8s |
| Request body size | 4.5MB | Enforced in UI |
| Vercel Blob storage | 500MB | Files auto-deleted |
| Vercel Blob bandwidth | 1GB/month | Varies |
| Vercel KV | 256MB | ~1KB per file record |
| Cron jobs | 1 per project | 1 (hourly cleanup) |
| Deployments | Unlimited | N/A |

---

## Local Development

```bash
# Copy env template
cp .env.example .env.local
# Fill in your values

# Install dependencies
npm install

# Run locally with Vercel dev
vercel dev
```

---

## Project Structure

```
/
├── api/
│   ├── telegram.js    # Telegram webhook handler
│   ├── upload.js      # Web UI upload endpoint
│   ├── cleanup.js     # Hourly cron: delete expired files
│   └── setup.js       # One-time webhook registration
├── public/
│   └── index.html     # Web upload UI
├── vercel.json        # Vercel config + cron schedule
├── package.json
└── .env.example
```
