import express from "express";
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  TRANSCODE_SHARED_SECRET,
  PORT = 8080,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TRANSCODE_SHARED_SECRET) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_ANON_KEY, TRANSCODE_SHARED_SECRET");
  process.exit(1);
}

// Anon client is only used to push the transcoded file to a signed upload URL.
// The upload is authorized by the one-time token, not by this key, so no
// service-role key is ever needed on the worker.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// The enqueue-transcode edge function dispatches jobs here with pre-signed URLs.
app.post("/transcode", (req, res) => {
  if (req.get("x-worker-secret") !== TRANSCODE_SHARED_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { asset_id, type, download_url, upload_path, upload_token, callback_url } = req.body || {};
  if (!asset_id || !type || !download_url || !upload_path || !upload_token || !callback_url) {
    return res.status(400).json({ error: "missing fields" });
  }
  // Acknowledge immediately; transcoding runs in the background.
  res.status(202).json({ accepted: true });
  processJob({ asset_id, type, download_url, upload_path, upload_token, callback_url })
    .catch(async (err) => {
      console.error(`[${asset_id}] transcode failed:`, err);
      await report(callback_url, { asset_id, status: "failed" });
    });
});

async function processJob({ asset_id, type, download_url, upload_path, upload_token, callback_url }) {
  const work = await mkdtemp(join(tmpdir(), "dripcast-"));
  try {
    const inputPath = join(work, "input");
    await download(download_url, inputPath);

    const { outputPath, mime, args } = buildFfmpeg(type, inputPath, work);
    await runFfmpeg(args);

    const fileBody = await readFile(outputPath);
    const { error } = await supabase.storage
      .from("processed")
      .uploadToSignedUrl(upload_path, upload_token, fileBody, { contentType: mime });
    if (error) throw error;

    const meta = await probe(outputPath);
    await report(callback_url, {
      asset_id,
      status: "ready",
      duration_seconds: meta.duration,
      width: meta.width,
      height: meta.height,
    });
    console.log(`[${asset_id}] ready -> processed/${upload_path}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

async function report(callback_url, payload) {
  try {
    await fetch(callback_url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": TRANSCODE_SHARED_SECRET },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("callback failed", e);
  }
}

function buildFfmpeg(type, input, work) {
  if (type === "voice") {
    const outputPath = join(work, "out.ogg");
    return {
      outputPath,
      mime: "audio/ogg",
      // OGG/OPUS mono = native Telegram voice note (waveform + inline play).
      args: ["-y", "-i", input, "-vn", "-c:a", "libopus", "-b:a", "64k",
        "-ar", "48000", "-ac", "1", "-application", "voip", outputPath],
    };
  }
  if (type === "video_note") {
    const outputPath = join(work, "out.mp4");
    return {
      outputPath,
      mime: "video/mp4",
      // Center-cropped square MP4, <=60s. Telegram rounds it client-side.
      args: ["-y", "-i", input, "-t", "60",
        "-vf", "crop=min(iw\\,ih):min(iw\\,ih),scale=384:384",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", outputPath],
    };
  }
  throw new Error(`unsupported transcode type: ${type}`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)));
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file]);
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === "video");
        const duration = Math.round(parseFloat(j.format?.duration || "0")) || null;
        resolve({ duration, width: v?.width ?? null, height: v?.height ?? null });
      } catch (e) {
        reject(e);
      }
    });
  });
}

app.listen(PORT, () => console.log(`Dripcast transcode worker listening on :${PORT}`));
