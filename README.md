# Dripcast Transcode Worker

A tiny stateless service that converts uploaded media into Telegram-native formats:

- **voice** → OGG/OPUS (renders as a native voice note with a waveform)
- **video_note** → centered square MP4, ≤60s (Telegram rounds it client-side)

Photos and regular videos are **not** sent here — the `enqueue-transcode` edge
function marks those `ready` directly, since Telegram accepts them as-is.

## How it fits

```
Composer upload ──► originals bucket + media_assets(pending)
        │
        ▼
enqueue-transcode (edge fn) ──► POST /transcode (this worker, x-worker-secret)
        │                              │
        │                              ├─ download original (service role)
        │                              ├─ ffmpeg (voice / video_note)
        │                              ├─ upload to processed bucket
        │                              └─ UPDATE media_assets ready + duration/dims
        ▼
Composer watches the row → Processing → Ready / Failed
```

The worker writes results straight back to `media_assets` with the service role,
so there is **no callback endpoint to maintain**.

## Endpoints

- `GET /health` → `{ ok: true }`
- `POST /transcode` (header `x-worker-secret: <TRANSCODE_SHARED_SECRET>`)
  body: `{ asset_id, type, org_id, storage_path }` → `202 { accepted: true }`,
  then transcodes in the background.

## Deploy on Railway

1. Push this folder to a new GitHub repo (or use `railway up`).
2. Create a new Railway project from the repo. It builds from the `Dockerfile`
   (ffmpeg is installed in the image).
3. Add these service **Variables** (see `.env.example`):
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — from your Lovable Cloud /
     Supabase project's API settings.
   - `TRANSCODE_SHARED_SECRET` — a long random string.
4. Deploy, then copy the public URL Railway gives you
   (e.g. `https://dripcast-worker-production.up.railway.app`).
5. In **Lovable Cloud**, set two edge-function secrets:
   - `RAILWAY_WORKER_URL` = that URL
   - `TRANSCODE_SHARED_SECRET` = the **same** value you set on Railway.
6. Verify: `curl https://your-worker-url/health` → `{"ok":true}`.

Only after this is live should you run Dripcast build Prompt 9a, so the
`enqueue-transcode` function can reach the worker.

## Local run

```bash
cp .env.example .env   # fill in values
npm install
npm start
```

## Notes

- The worker holds the service-role key — keep it on Railway only, never in the
  browser app.
- ffmpeg recipes live in `buildFfmpeg()` in `index.js`. Bump `scale=384:384` to
  `512:512` for sharper video notes (larger files).
- Transcoding runs per request; for very high volume, put a real queue (pgmq)
  in front later — the contract (`POST /transcode`) stays the same.
