# Dripcast Transcode Worker

Stateless service that converts uploaded media into Telegram-native formats:

- **voice** → OGG/OPUS (native voice note with a waveform)
- **video_note** → centered square MP4, ≤60s (Telegram rounds it client-side)

Photos and regular videos never reach this worker — the `enqueue-transcode`
edge function marks those `ready` directly.

## Why no service-role key

On **Lovable Cloud**, the Supabase service-role key is not accessible to you.
So this worker holds **zero database credentials**. Instead:

```
Composer upload ──► originals bucket + media_assets(pending)
        │
        ▼
enqueue-transcode (edge fn, runs inside Lovable Cloud)
        │  mints a signed DOWNLOAD url (original)
        │  mints a signed UPLOAD url  (processed)
        ▼
   POST /transcode (this worker, x-worker-secret) with those URLs
        │  fetch(download_url) → ffmpeg → uploadToSignedUrl(processed)
        ▼
   POST callback_url (transcode-callback edge fn, x-worker-secret)
        │  status + duration/dims
        ▼
   media_assets ready / failed   ← updated by the edge fn (privileged, internal)
```

The signed UPLOAD url is authorized by a one-time token, so the worker's anon
key has no special power — it's just needed to call `uploadToSignedUrl`.

## Endpoints

- `GET /health` → `{ ok: true }`
- `POST /transcode` (header `x-worker-secret`) body:
  `{ asset_id, type, download_url, upload_path, upload_token, callback_url }`
  → `202`, then transcodes in the background and POSTs the callback.

## Deploy on Railway

1. Push this folder to a GitHub repo (or `railway up`).
2. New Railway project from the repo — it builds from the `Dockerfile` (ffmpeg
   is installed in the image).
3. Add Variables (see `.env.example`):
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` — copy both from your Lovable repo
     file `src/integrations/supabase/client.ts`.
   - `TRANSCODE_SHARED_SECRET` — a long random string.
4. Deploy, then copy the public URL Railway gives you.
5. In **Lovable Cloud**, set two edge-function secrets:
   - `RAILWAY_WORKER_URL` = that URL
   - `TRANSCODE_SHARED_SECRET` = the **same** value as on Railway.
6. Verify: `curl https://your-worker-url/health` → `{"ok":true}`.

Run Dripcast build Prompt 9a only after this is live.

## Local run

```bash
cp .env.example .env   # fill in values
npm install
npm start
```
