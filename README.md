<p align="center">
  <img src="assets/icon.svg" width="88" height="88" alt="mcp-video-analyzer-plus" />
</p>

<h1 align="center">mcp-video-analyzer-plus</h1>

<p align="center"><em>Turn any video — YouTube, Instagram, TikTok, Loom, X, Vimeo, direct links, local files — into transcripts, key frames, OCR text, and metadata for AI agents.</em></p>

<p align="center">
  <a href="https://github.com/ctadros1/mcp-video-analyzer-plus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?labelColor=1e1e2e" alt="license" /></a>
</p>

> ### Fork of [guimatheus92/mcp-video-analyzer](https://github.com/guimatheus92/mcp-video-analyzer) — added: smart frame selection, URL/file fallback, zip export
>
> Everything upstream does, plus three additions:
>
> 1. **[Smart frame selection](#smart-frame-selection)** — frames are over-sampled, scored (sharpness, on-screen-text density) and selected for diversity, instead of keeping whatever ffmpeg's scene detector fired on. On by default; `frameSelection: "sceneChange"` restores the upstream path.
> 2. **[URL + local-file fallback](#url--local-file-fallback)** — every video tool accepts an optional `localFallbackPath` and uses it automatically when the remote source is blocked or unreachable (YouTube anti-bot, missing yt-dlp, network failure).
> 3. **[`export_video_bundle`](#exporting-a-zip-bundle)** — a ninth tool that packages the analysis as a `.zip` on disk: key frames in a `frames/` folder, the transcript as `transcript.md`.
>
> All three are additive: existing calls behave exactly as before. Upstream's adapter and extraction code is deliberately left close to original so `git pull upstream main` keeps working — that surface is an active arms race against YouTube and is best tracked, not rewritten.
>
> **Not published to npm** — install it straight from GitHub, or clone and build. Both take about a minute: see **[Setup](#setup)**. Original work and continuing credit: [Guilherme Matheus](https://github.com/guimatheus92). MIT licensed, as upstream.

No existing video MCP combines **transcripts + visual frames + metadata** in one tool. This one does — across Loom, the major yt-dlp platforms (YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook), direct video URLs, and local files.

> **Want a full pipeline, not just a tool?** [social-knowledge-base](https://github.com/guimatheus92/social-knowledge-base) is built on top of this server — it downloads whole Instagram creator accounts (reels, stories, highlights), transcribes them, and turns the result into a searchable, RAG-queryable knowledge base with AI-generated notes. Use this MCP when you want per-video analysis inside an agent; use social-knowledge-base when you want to archive and query an entire account.

## Quick start

Add this to your MCP client's config, restart it, and paste a video link. That's the whole install — npm fetches and builds the server for you.

```json
{
  "mcpServers": {
    "video-analyzer": {
      "command": "npx",
      "args": ["-y", "github:ctadros1/mcp-video-analyzer-plus"]
    }
  }
}
```

<sup>Claude Desktop config lives at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Needs Node 22.12+. Full walkthrough, other clients and troubleshooting: **[Setup](#setup)**.</sup>

## Setup

Two ways in. Pick one — you don't need both.

| | **A — one line, no clone** | **B — local clone** |
|---|---|---|
| Steps | Paste one config block | Clone, build, then paste |
| First launch | Slow (npm builds it: 1–2 min) | Instant |
| Updating | Automatic on cache miss | `git pull && npm run build` |
| Editing the code | No | Yes |
| Best for | Just using it | Hacking on it, or if A times out |

**Start with A.** Fall back to B if your client times out waiting for the server to boot, or if you want to change the code.

### Step 1 — Prerequisites

```bash
node --version    # need v22.12 or newer
yt-dlp --version  # optional, but required for YouTube/TikTok/Instagram/X/…
```

- **Node.js 22.12+** — required. [Download](https://nodejs.org/) or `brew install node`.
- **yt-dlp** — install with `pip install yt-dlp` (or `brew install yt-dlp`). Needed only for platform URLs. Loom, direct `.mp4`/`.webm`/`.mov` links and local files work without it.
- **ffmpeg** — **not** needed. A binary ships with the package.
- **Chrome/Chromium** — optional last-resort frame extraction if yt-dlp is missing.

> Missing yt-dlp is never a crash: platform URLs come back with a clear "install yt-dlp" note in `warnings`, and everything else keeps working.

---

### Route A — one line, no clone

npm fetches the repo and builds it for you. Nothing to clone, no path to maintain.

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "video-analyzer": {
      "command": "npx",
      "args": ["-y", "github:ctadros1/mcp-video-analyzer-plus"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add video-analyzer -- npx -y github:ctadros1/mcp-video-analyzer-plus
```

Then go to [Step 3](#step-3--restart-and-verify).

> **The first launch compiles the project**, which can take a minute or two on a cold npm cache — long enough that a client may give up waiting for the server to answer. If the server shows as failed on first start, either try again (the build is now cached) or use Route B, which has no such window.

---

### Route B — local clone

**Step 2a — clone and build**

```bash
git clone https://github.com/ctadros1/mcp-video-analyzer-plus.git
cd mcp-video-analyzer-plus
npm install
```

`npm install` builds the project automatically via the `prepare` script. To be sure, run `npm run build` — it is safe to run twice.

**Step 2b — get the absolute path**

Every config below needs the **absolute** path to `dist/index.js`, because your MCP client does not run from a predictable directory. Print it:

```bash
echo "$PWD/dist/index.js"
```

Copy that line. It looks like `/Users/you/code/mcp-video-analyzer-plus/dist/index.js`. Substitute it wherever the blocks below say `/ABSOLUTE/PATH/TO`.

**Step 2c — register the server**

<details open>
<summary><b>Claude Desktop</b></summary>

<br>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Create the file if it isn't there:

```json
{
  "mcpServers": {
    "video-analyzer": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-video-analyzer-plus/dist/index.js"]
    }
  }
}
```

If you already have other servers, add `video-analyzer` alongside them — don't replace the whole `mcpServers` object.

</details>

<details>
<summary><b>Claude Code</b></summary>

<br>

```bash
claude mcp add video-analyzer -- node /ABSOLUTE/PATH/TO/mcp-video-analyzer-plus/dist/index.js
```

</details>

<details>
<summary><b>VS Code / Cursor</b></summary>

<br>

VS Code: `~/.vscode/mcp.json` (or `%APPDATA%\Code\User\mcp.json`). Cursor: **Settings → MCP Servers → Add**.

```json
{
  "servers": {
    "video-analyzer": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-video-analyzer-plus/dist/index.js"]
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code plugin (adds the <code>/video</code> slash command)</b></summary>

<br>

```
/plugin marketplace add ctadros1/mcp-video-analyzer-plus
/plugin install video@mcp-video-analyzer-plus
```

Registers the MCP server *and* a `/video` command. Requires the clone to be built, since the bundled config launches `dist/index.js` from the plugin directory.

```
/video https://youtu.be/jNQXAC9IVRw what happens at 0:10?
```

</details>

---

### Step 3 — restart and verify

**Fully quit your client and reopen it.** On macOS that means **Cmd+Q**, not closing the window — MCP servers are only loaded at startup.

Then ask it:

```
Analyze this video: https://www.youtube.com/watch?v=jNQXAC9IVRw
```

It should call `analyze_video` on its own, with no prompting.

**Confirm you're on the fork, not upstream:** ask for the tool list and look for **`export_video_bundle`**. Upstream has eight tools and no such name; this fork has nine.

---

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Server doesn't appear at all | Client wasn't fully restarted | Cmd+Q and reopen — closing the window is not enough |
| "server failed to start" on Route A | First-run build exceeded the client's startup timeout | Retry (the build is cached now), or switch to Route B |
| "Cannot find module …/dist/index.js" | Never built, or path is wrong | `npm run build` in the clone, then re-check the path from Step 2b |
| Config changes do nothing | Malformed JSON — the client silently ignores the file | `node -e "require('/path/to/claude_desktop_config.json')"` — it prints the syntax error |
| Old behaviour after `git pull` | `dist/` is gitignored and not rebuilt automatically | `npm run build`, then restart the client |
| `export_video_bundle` missing | Still running upstream | Check the config actually points at this fork |
| YouTube link fails, others work | yt-dlp missing, or the video is blocked | `pip install yt-dlp`; for blocked videos pass `localFallbackPath` — see [URL + local-file fallback](#url--local-file-fallback) |
| Instagram / age-restricted fails | Needs a logged-in session | Set `YTDLP_COOKIES_FROM_BROWSER=chrome` or `YTDLP_COOKIES=<netscape-cookie-file>` |

### Keeping it up to date

Route A updates itself. For Route B:

```bash
cd mcp-video-analyzer-plus
git pull
npm install && npm run build
```

Then restart your client. **The rebuild is not optional** — `dist/` is gitignored, so without it you keep running the old compiled code.

To pull in fixes from the original project (worth doing when YouTube changes and upstream ships a yt-dlp fix):

```bash
git pull upstream main
npm install && npm run build
```

### CLI (one-shot, no MCP client)

The same engine runs as a plain command — useful for scripts, or for any agent that has a shell but no MCP:

```bash
# Route A — no clone
npx -y github:ctadros1/mcp-video-analyzer-plus analyze "https://youtu.be/jNQXAC9IVRw"

# Route B — local clone
node /ABSOLUTE/PATH/TO/mcp-video-analyzer-plus/dist/index.js analyze "https://youtu.be/jNQXAC9IVRw"
```

stdout is a single JSON document — `metadata`, `transcript`, `ocrResults`, `timeline`, `warnings`, `frameCount`, and `frames` as `{ time, filePath, mimeType }` entries pointing at JPEG key frames copied to `--out` (default: the per-user cache dir — `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux — under `mcp-video-analyzer/<source-hash>/`; set `MCP_CACHE_DIR` to an absolute path to relocate it). Nothing reaps that location, so frames persist until you delete them; the directories are created `0700`. Progress streams on stderr, so stdout pipes straight into a JSON parser. Partial failures land in `warnings` with exit code 0; only hard failures exit 1.

| Flag | Description |
|------|-------------|
| `--detail <level>` | `brief` (metadata + transcript, no frames), `standard` (default), `detailed` |
| `--max-frames <n>` | Max key frames, 1–60 (default adapts to duration) |
| `--max-width <px>` | Width cap for emitted frames (default `800`, or `MCP_FRAME_MAX_WIDTH`); `0` keeps the source resolution — see [Frame size](#frame-size-dense-ui-captures) |
| `--fields <list>` | Output filter — comma-separated subset: `metadata,transcript,frames,comments,chapters,ocrResults,timeline,aiSummary`. Filters the emitted JSON only; use `--detail brief` to actually skip download/frame extraction |
| `--force-refresh` | Bypass the cache and re-analyze |
| `--frame-selection <mode>` | `smart` (default) or `sceneChange` — see [Smart frame selection](#smart-frame-selection) |
| `--frame-candidates <n>` | Candidates generated per requested frame in smart mode, 1–6 (default `3`, capped at 90 total) |
| `--frame-ocr-weight <w>` | Share of the smart score carried by on-screen text, 0–1 (default `0.4`) |
| `--local-fallback <path>` | Local copy of the video, used automatically if the remote source fails — see [URL + local-file fallback](#url--local-file-fallback). Works with no positional URL too |
| `--zip <path>` | Also package the result as a `.zip` (`frames/` + `transcript.md`) at `<path>`; a directory puts it inside under the video's title — see [Exporting a zip bundle](#exporting-a-zip-bundle) |
| `--ocr-language <codes>` | Tesseract languages (default `eng+por`) |
| `--model <name>` / `--language <code>` | Whisper overrides for the transcription fallback |
| `--out <dir>` | Where frame images are copied |

Run it with no arguments to start the MCP stdio server instead — the CLI is purely additive.

## Tools

Nine tools — the AI picks the cheapest one for the job and calls it automatically. Click any tool to expand its parameters and examples.

All seven single-video tools (everything except the batch `analyze_videos`) accept an optional **`localFallbackPath`** alongside `url`, and use it automatically when the remote source is blocked or unreachable — see [URL + local-file fallback](#url--local-file-fallback).

| Tool | What it does |
|------|--------------|
| **`analyze_video`** | Full analysis: transcript + key frames + OCR + timeline + metadata |
| **`analyze_videos`** | Batch version, one structured result per source (resumable) |
| **`get_transcript`** | Transcript only (native captions or Whisper fallback) |
| **`get_metadata`** | Metadata + comments + chapters, no download |
| **`get_frames`** | Key frames only (smart selection, scene-change, or dense 1 fps) |
| **`analyze_moment`** | Deep-dive on a time range (burst frames + transcript + OCR) |
| **`get_frame_at`** | Single frame at a timestamp |
| **`get_frame_burst`** | N frames across a narrow window (motion/animation) |
| **`export_video_bundle`** | Packages the analysis as a `.zip` on disk — `frames/` + `transcript.md` |

<details>
<summary><b><code>analyze_video</code></b> — full video analysis</summary>

<br>

Extracts everything from a video URL in one call:

```
> Analyze this video: https://www.youtube.com/watch?v=abc123...
```

Returns:
- **Transcript** with timestamps and speakers
- **Key frames** chosen by [smart selection](#smart-frame-selection): candidates are over-sampled from scene cuts *and* uniform sampling, scored on sharpness and on-screen-text density, then kept only if distinct from every frame already selected. Blurred transition frames are rejected, look-alikes far apart in time are not both kept, and passages that change gradually still produce frames instead of an empty result.
- **OCR text** extracted from frames (code, error messages, UI text, prices/dates/CTAs visible on screen)
- **Annotated timeline** merging transcript + frames + OCR into a unified "what happened when" view
- **Metadata** (title, duration, platform)
- **Comments** from viewers
- **Chapters** and **AI summary** (when available)

The AI will **automatically** call this tool when it sees a video URL — no need to ask.

Options:
- `detail` — analysis depth: `"brief"` (metadata + truncated transcript, no frames), `"standard"` (default), `"detailed"` (dense sampling, more frames)
- `fields` — array of specific fields to return, e.g. `["metadata", "transcript"]`. Available: `metadata`, `transcript`, `frames`, `comments`, `chapters`, `ocrResults`, `timeline`, `aiSummary`
- `maxFrames` (1-60) — cap on extracted frames. Default scales with video duration at `standard` detail (~12 for ≤30s up to 60 for >10min); fixed 60 at `detailed`, 0 at `brief`. An explicit value always wins
- `threshold` (0.0-1.0, default 0.1) — scene-change sensitivity. In smart mode this seeds candidate generation at a relaxed fraction of the value
- `frameSelection` — `"smart"` (default) or `"sceneChange"` (upstream behaviour). See [Smart frame selection](#smart-frame-selection)
- `frameCandidateMultiplier` (1-6, default 3) — candidates generated per requested frame in smart mode
- `frameOcrWeight` (0-1, default 0.4) — share of the smart score carried by on-screen text; the rest is sharpness
- `localFallbackPath` — absolute path to a local copy, used automatically if the remote source fails. See [URL + local-file fallback](#url--local-file-fallback)
- `forceRefresh` — bypass cache and re-analyze
- `skipFrames` — skip frame extraction for transcript-only analysis
- `model` / `language` / `initialPrompt` — per-call Whisper overrides for the transcription fallback (override `WHISPER_MODEL` / `WHISPER_LANGUAGE` / `WHISPER_PROMPT` for this call only — pick a heavier model or a domain glossary for one hard clip without restarting the server)

</details>

<details>
<summary><b><code>export_video_bundle</code></b> — zip the frames + transcript</summary>

<br>

```
> Export this video: https://youtu.be/jNQXAC9IVRw
> Save the frames and transcript to my Desktop as a zip
```

Runs the full analysis, then writes a `.zip` containing `frames/` (the key frames, named ordinal-first with their timestamps) and `transcript.md`. Returns the archive's absolute path, size, and manifest — the file is on disk, not in the response.

Options: `outputPath` (absolute file or directory; defaults to the per-user cache dir), `localFallbackPath`, and every `analyze_video` option.

Full details: [Exporting a zip bundle](#exporting-a-zip-bundle).

</details>

<details>
<summary><b><code>analyze_videos</code></b> — batch analysis</summary>

<br>

```
> Analyze every .mp4 in this folder
```

Runs `analyze_video` over a list of `sources` with a `concurrency` limit (default 2), returning one **structured result per source** — counts + warnings on success, or a per-item `error` on failure (one bad file never aborts the batch). Frame images are not inlined and full transcript/OCR/timeline are returned only when `fields` is set; otherwise you get counts. Pair with `MCP_WRITE_SIDECARS=1` (below) so each video's result persists to disk and a re-run resumes instead of recomputing.

</details>

<details>
<summary><b><code>get_transcript</code></b> — transcript only</summary>

<br>

```
> Get the transcript from this video
```

Quick transcript extraction. Falls back to Whisper transcription when no native transcript is available. Accepts the same per-call `model` / `language` / `initialPrompt` overrides as `analyze_video`, plus `localFallbackPath`.

</details>

<details>
<summary><b><code>get_metadata</code></b> — metadata only</summary>

<br>

```
> What's this video about?
```

Returns metadata, comments, chapters, and AI summary without downloading the video.

</details>

<details>
<summary><b><code>get_frames</code></b> — frames only</summary>

<br>

```
> Extract frames from this video with dense sampling
```

Three modes:
- **Smart selection** (default) — over-samples candidates, scores them on sharpness, and keeps a visually diverse subset. This tool does not run OCR, so the on-screen-text signal is not part of the score here; use `analyze_video` when that matters
- **Scene-change detection** (`frameSelection: "sceneChange"`) — upstream behaviour, captures visual transitions
- **Dense sampling** (`dense: true`) — 1 frame/sec for full coverage; takes precedence over `frameSelection`

The `mode` field of the response reports which one ran: `"smart"`, `"scene"`, or `"dense"`.

Options: `maxFrames` (default 20), `threshold`, `dense`, `frameSelection`, `maxWidth`, and `localFallbackPath`.

</details>

<details>
<summary><b><code>analyze_moment</code></b> — deep-dive on a time range</summary>

<br>

```
> Analyze what happens between 1:30 and 2:00 in this video
```

Combines burst frame extraction + filtered transcript + OCR + annotated timeline for a focused segment. Use when you need to understand exactly what happens at a specific moment.

</details>

<details>
<summary><b><code>get_frame_at</code></b> — single frame at a timestamp</summary>

<br>

```
> Show me the frame at 1:23 in this video
```

The AI reads the transcript, spots a critical moment, and requests the exact frame to see what's on screen.

</details>

<details>
<summary><b><code>get_frame_burst</code></b> — N frames in a time range</summary>

<br>

```
> Show me 10 frames between 0:15 and 0:17 of this video
```

For motion, vibration, animations, or fast scrolling — burst mode captures N frames in a narrow window so the AI can see frame-by-frame changes.

</details>

## Detail Levels

| Level | Frames | Transcript | OCR | Timeline | Use case |
|-------|--------|-----------|-----|----------|----------|
| `brief` | None | First 10 entries | No | No | Quick check — what's this video about? |
| `standard` | Duration-adaptive: ~12 (≤30s) up to 60 (>10min), scene-change | Full | Yes | Yes | Default — full analysis |
| `detailed` | Up to 60 (1fps dense) | Full | Yes | Yes | Deep analysis — every second captured |

## Caching

Results are cached in memory for 10 minutes. Subsequent calls with the same URL and options return instantly. Use `forceRefresh: true` to bypass the cache. `skipFrames` is part of the cache and sidecar key, so a transcript-only analysis and a framed one of the same URL never answer for each other.

### Persistent sidecars (resumable bulk processing)

The in-memory cache is lost on restart, which makes reprocessing a large local corpus costly. Set `MCP_WRITE_SIDECARS=1` to also persist results **next to each local video** so the work survives restarts and can resume:

- `<stem>.vtt` — the transcript, **only** when it was generated by the Whisper fallback (an existing `<stem>.vtt` from your own pipeline is never overwritten). A later call reuses it via the normal sidecar reader and skips Whisper entirely.
- `<stem>.analysis.json` + `<stem>.frames/` — the full result (frames + OCR + timeline), keyed by the video's `mtime:size` and the analysis params. On a later call with a matching stamp + params, the result is returned straight from disk (no extraction, no OCR).

This makes `analyze_videos` over thousands of files resumable, and lets an external GPU transcription pipeline and this MCP share results through the filesystem: the pipeline writes `<stem>.vtt`, and the MCP picks it up instead of running Whisper.

## Supported Sources

| Source | Transcript | Metadata | Comments | Frames | Auth |
|--------|:----------:|:--------:|:--------:|:------:|:----:|
| **Loom** | Yes | Yes | Yes | Yes (usually needs yt-dlp — see note) | None |
| **YouTube / Vimeo / TikTok / Instagram / X / Twitch / Dailymotion / Facebook** | Native captions (uploaded > auto-generated) or Whisper fallback | Yes (title, duration, uploader, views, chapters, upload date) | No | Yes (capped at 1080p) | yt-dlp installed; cookies for Instagram / age-restricted (see below) |
| **Direct URL** (.mp4, .mov, .mkv, .webm, …) | No | Duration only | No | Yes | None |
| **Direct URL + TwelveLabs** | Yes (Pegasus, best-effort) | Duration floor + title | No | Yes | `TWELVELABS_API_KEY` |
| **Local file** (absolute path or `file://` URI) | Sidecar `.vtt`/`.srt` or Whisper fallback | Probed via ffmpeg (duration, dims, codec, audio presence) | No | Yes | None |

> **Loom frames**: transcript, metadata, and comments come straight from Loom's API with no extra tooling. Frame extraction is different — Loom serves most videos as separate DASH video+audio streams, which only [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`) fetches and merges. Merging uses the bundled `ffmpeg-static`, so no system ffmpeg is required. Without yt-dlp a direct-CDN fallback still covers some videos; when it can't, you get transcript + metadata + comments plus a warning explaining why frames are missing.
>
> **Local files**: pass an absolute path (e.g., `/Users/you/clip.mp4`) or a `file://` URI as the `url` argument to any tool. Relative paths are rejected — the server's working directory is unpredictable from the MCP client. Note that any caller of the MCP server can ask it to read any file the server process has access to.
>
> **Sidecar transcripts**: if a `clip.vtt`, `clip.srt`, `clip.en.vtt`, etc. lives next to `clip.mp4`, it's used as the transcript automatically — no Whisper roundtrip needed. SRT is converted to VTT in-memory.
>
> **Embedded subtitles**: if no sidecar is found and the container has an embedded subtitle stream (common in `.mkv` / `.mov` / `.mp4` from screen recorders), it's transmuxed to VTT via ffmpeg and used as the transcript.
>
> **Recognized extensions** (local files and direct URLs): `.mp4` `.mov` `.mkv` `.webm` `.avi` `.m4v` `.wmv` `.flv` `.mpeg` `.mpg` `.m2ts` `.mts` `.3gp` `.ogv`. The extension only gates routing — ffmpeg does the actual demuxing, so most common containers work. `.ts` is excluded to avoid colliding with TypeScript source files.

### Platform URLs via yt-dlp (YouTube, Instagram, TikTok, …)

Single-video pages on major platforms route through [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp` — required for these URLs). Playlists, channels, and profile pages are rejected by design; pass individual video URLs (batch them with `analyze_videos`).

- **Transcript**: native captions are preferred and free — uploaded subtitles first, auto-generated captions as fallback (rolling-window duplication is collapsed). `WHISPER_LANGUAGE` (e.g. `pt`) is also used to pick the caption language. Videos with no captions at all fall through to the normal Whisper chain.
- **Metadata**: title, duration, uploader/channel, view count, upload date, and chapters — no download needed.
- **Download**: capped at 1080p (frames/OCR don't need more), live streams are skipped, and DASH audio+video is merged with the bundled `ffmpeg-static` (no system ffmpeg required).
- **Cookies** — Instagram and age-restricted videos usually require a logged-in session:

| Env var | What it does | Example |
|---------|-------------|---------|
| `YTDLP_COOKIES` | Cookie file (Netscape format), wins when both are set | `C:/secrets/cookies.txt` |
| `YTDLP_COOKIES_FROM_BROWSER` | Extract cookies from an installed browser | `chrome`, `edge`, `firefox` |

> Browser cookie extraction requires the browser to be **closed** on Windows (the cookie database is locked while it runs). If that's inconvenient, export a `cookies.txt` once (e.g. with a "Get cookies.txt" browser extension) and point `YTDLP_COOKIES` at it. Private/age-restricted videos without valid cookies don't crash the tool — the yt-dlp `ERROR:` line surfaces in `warnings[]`.

### TwelveLabs Pegasus (optional)

Set the `TWELVELABS_API_KEY` environment variable to analyze direct video URLs with [TwelveLabs](https://twelvelabs.io) **Pegasus**. Pegasus analyzes the video server-side (visuals **and** its own audio) and returns an **AI-generated, timestamped transcript** plus an AI summary as text — capabilities the `DirectAdapter` can't provide (a raw `.mp4` URL has no transcript or summary on its own), and with **no Whisper key required**.

The transcript is best-effort LLM output, not a deterministic ASR dump: Pegasus is *prompted* to emit `[MM:SS] line` rows, and lines that don't match that shape are dropped, so wording and exact timestamps depend on the model's prompt adherence. Failures (bad key, timeout, API error) surface in the tool's `warnings[]` rather than silently returning an empty transcript.

The biggest win is on the text-only paths: `get_transcript` and `get_metadata` return a Pegasus transcript and summary for direct URLs — a few KB of text, no frame images, no per-frame token cost. `analyze_video` at `detail: "standard"`/`"detailed"` still extracts frames in addition (use `detail: "brief"` to stay text-only).

> **Long videos**: the summary and full transcript share a single capped completion (`max_tokens` = 16384), so for very long videos the transcript may be truncated. For multi-hour content, chunking by time window is the better approach.

It's fully opt-in and non-breaking: when `TWELVELABS_API_KEY` is set the `TwelveLabsAdapter` handles direct video URLs (it registers the public URL with TwelveLabs — no upload); when it's unset, the `DirectAdapter` handles them exactly as before. Loom URLs are unaffected. Get a key at [playground.twelvelabs.io](https://playground.twelvelabs.io).

### Transcription (Whisper fallback)

When a source has no native transcript (no sidecar `.vtt`/`.srt`, no embedded subtitles, no platform captions), the audio track is transcribed with Whisper via a graceful fallback chain (in execution order):

> **Silent tracks**: before any Whisper run, the audio is probed with ffmpeg `volumedetect` (first 2 minutes). A present-but-mute track — common in muted Reels/Stories — skips transcription entirely and emits a warning that the empty transcript is **expected content, not an error**, saving a pointless Whisper run.

1. **@huggingface/transformers** (JS-native, zero external deps) — **opt-in only**: this strategy runs *first*, but **only when `WHISPER_HF_MODEL` is explicitly set**. When it's unset (the default) the strategy is skipped entirely, so the CLI below wins and its `WHISPER_MODEL`/`WHISPER_LANGUAGE` settings are never silently overridden.
2. **`whisper` CLI** — used when a `whisper` executable is found (`pip install -U openai-whisper`). Point `WHISPER_BIN` at the executable if it isn't on `PATH`. Model via `WHISPER_MODEL`, language via `WHISPER_LANGUAGE`. The bundled `ffmpeg-static` is put on the CLI's `PATH` automatically, so no system ffmpeg is required.
3. **OpenAI Whisper API** — used when `OPENAI_API_KEY` is set.

> **No backend configured?** If none of the three is available (no `whisper` on `PATH`/`WHISPER_BIN`, no `OPENAI_API_KEY`, no `WHISPER_HF_MODEL`), transcription tools return an empty transcript **with a warning telling you how to enable one** — rather than a silent "no transcript". Install `openai-whisper` or set one of the keys above. (The CLI is spawned with `PYTHONUTF8=1` so non-English/CJK transcripts don't crash the Python process on Windows.)

| Env var | Applies to | Default | Example |
|---------|-----------|---------|---------|
| `WHISPER_MODEL` | `whisper` CLI | `tiny` | `small`, `medium` |
| `WHISPER_LANGUAGE` | `whisper` CLI / OpenAI API | auto-detect | `pt`, `en`, `es` |
| `WHISPER_PROMPT` | `whisper` CLI / OpenAI API | — | `Doha, Smiles, Livelo, Latam, milheiro` |
| `WHISPER_BIN` | `whisper` CLI | `whisper` (on PATH) | `C:/.../Scripts/whisper.exe` |
| `WHISPER_DEVICE` | `whisper` CLI (sent only if set) | — | `cuda`, `cpu` |
| `WHISPER_COMPUTE` | `whisper-ctranslate2` only | — | `float16`, `int8_float16`, `int8` |
| `WHISPER_BEAM_SIZE` | `whisper` CLI (sent only if set) | — | `5` |
| `WHISPER_WORD_TIMESTAMPS` | `whisper` CLI (sent only if set) | off | `1` |
| `WHISPER_HF_MODEL` | HF transformers (opt-in) | — (strategy off) | `Xenova/whisper-small` |
| `OPENAI_API_KEY` | OpenAI API | — | `sk-…` |

> The default `tiny` model is fast but weak for non-English audio. For Portuguese (or other non-English) sources, install the CLI and set `WHISPER_MODEL=small` (or `medium`) + `WHISPER_LANGUAGE=pt` for much better accuracy. Add `WHISPER_PROMPT` with a domain glossary (brand/place names) to fix proper nouns. You can also override `model`/`language`/`initialPrompt` **per call** on `analyze_video` / `get_transcript` / `analyze_videos` — no restart needed.
>
> **GPU (faster-whisper):** `whisper-ctranslate2` (`pip install -U whisper-ctranslate2`) is a drop-in CLI with the same flags plus `--device cuda` / `--compute_type` / `--beam_size`. Point `WHISPER_BIN` at it and set `WHISPER_DEVICE=cuda` (+ optionally `WHISPER_COMPUTE=float16`). These GPU flags are **env-gated** — they're only passed when set, so plain `openai-whisper` (which rejects `--compute_type`) keeps working when they're unset.
>
> **Windows note:** pip installs `whisper.exe` into the Python `Scripts/` dir, which is often **not** on the `PATH` that GUI-launched MCP clients inherit. If transcripts come back empty, set `WHISPER_BIN` to the full path of `whisper.exe`.

### Frame Extraction Strategies

Frame extraction uses a two-strategy fallback chain — no single dependency is required:

| Strategy | How it works | Speed | Requirements |
|----------|-------------|-------|-------------|
| **yt-dlp + ffmpeg** (primary) | Downloads video, then over-samples and selects frames ([smart selection](#smart-frame-selection)) | Fast, precise | [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`pip install yt-dlp`) |
| **Browser** (fallback) | Opens video in headless Chrome, seeks to timestamps, takes screenshots | Slower, no download needed | Chrome or Chromium installed |

The fallback is automatic — if yt-dlp is not available, the server tries browser-based extraction via `puppeteer-core`. If neither is available, analysis still returns transcript + metadata + comments, just no frames. A third route exists when you have the file locally: pass [`localFallbackPath`](#url--local-file-fallback) and a blocked remote source is retried against it automatically.

### Smart frame selection

Upstream picks frames by asking ffmpeg's scene detector where the pixels changed a lot, then drops a frame if it looks like the one immediately before it. That has three failure modes, all of them visible in practice:

- a hard cut fires mid-transition, so the frame you get is **motion-blurred**;
- two near-identical frames both survive when they are **not adjacent** in the sequence, because deduplication only ever compares neighbours;
- a passage that changes **gradually** — a scrolling document, a dashboard redrawing, a slide fading — never crosses the threshold and produces **no frames at all**.

Smart selection replaces "keep what fired" with over-sample → score → select. It is the default; nothing needs to be passed to get it.

**1. Over-sample.** Candidates come from two sources, merged: the scene detector at a much lower threshold (40% of yours, floor 0.02), and uniform temporal sampling. Neither alone is enough — scene cuts miss gradual passages, uniform sampling lands mid-transition on hard cuts. The pool is `maxFrames × frameCandidateMultiplier` (default 3), capped at 90 candidates.

**2. Score.** Each candidate gets a combined score from two signals, both normalized against the pool's own maximum:

| Signal | How | Weight |
|--------|-----|--------|
| **Sharpness** | Laplacian variance, computed with `sharp` at a fixed 320 px width. Blur and dissolve frames smear out the edges that produce a high variance, so they sink. | `1 − frameOcrWeight` |
| **On-screen text** | `log1p(characters) × confidence` from the OCR pass (tesseract.js, already a dependency). | `frameOcrWeight` (default `0.4`) |

Normalizing against the pool maximum is what keeps the text signal from punishing b-roll: on a clip where nothing is legible, every candidate scores zero for text and sharpness alone decides the ranking. The weight is configurable — raise it for screen recordings and slide decks, set it to `0` to rank on sharpness alone.

**3. Cluster temporally.** The timeline is partitioned into buckets — scene cuts as boundaries, each scene subdivided in proportion to its length so there are roughly as many buckets as frames requested — and selection takes each bucket's own best in turn.

This exists because scoring alone has a failure mode it cannot fix: if one passage is sharper or more text-dense than the rest, it wins every comparison and the entire budget lands inside it. In the test fixture for this, a global ranking puts **all four** frames in the opening eight seconds of a 57-second clip; bucketed selection spreads them. A clip with no scene cuts at all — a screen recording that only ever changes gradually — still buckets, evenly by time, so it gets coverage instead of a cluster.

Round-robin rather than a per-bucket quota: the buckets are already sized so a longer scene contains more of them, so proportional allocation falls out of the rounds, and an empty or duplicate-only bucket simply drops out. Anything the buckets can't fill is filled globally rather than returned short.

> The idea is [LVNet](https://github.com/jongwoopark7978/LVNet)'s (Park et al., *Too Many Frames, Not All Useful*), whose pipeline opens with Temporal Scene Clustering for the same reason. Its later stages score frames with CLIP against the question being asked — that needs a question up front, a GPU, and per-frame model inference, none of which belong in an MCP server. The clustering stage needs none of them.

**4. Select.** Within that structure, greedy by score, keeping a candidate only if it is distinct from **every** frame already kept — not merely from the previous one. Distinctness needs all three of these to agree before two frames count as the same:

- **On-screen text** — different legible text means different information, whatever the pixels say. (The same rule upstream's text-aware dedup already applies to overlay-only clips.)
- **Perceptual hash** — the dHash + Hamming distance from `frame-dedup.ts`, applied pairwise across the whole pool.
- **Mean colour** — because dHash greyscales the frame and compares each pixel to its right neighbour, so it encodes gradient and discards colour entirely: solid red, blue and green cards hash *identically*. Mean colour is the cheap signal that covers exactly that blind spot, from the `sharp` stats call the black-frame filter already makes.

The distinctness rule is never relaxed — a bucket that holds nothing new contributes nothing, and the budget is filled from elsewhere.

> The hash is the weakest of the three and could not carry the decision alone. Measured across this repo's own fixtures, dHash spans almost no range: a 30-second moving clip tops out at 5–6 differing bits of 72, and clips whose on-screen text changes top out at 1–2. Using it at upstream's threshold of 5 as a global gate kept **one** frame out of thirty.

**Options** (`analyze_video`, `analyze_videos`; `frameSelection` also on `get_frames`):

| Option | Default | Meaning |
|--------|---------|---------|
| `frameSelection` | `"smart"` | `"sceneChange"` restores the upstream path — scene detector only, adjacent-frame dedup. Faster, no scoring. |
| `frameCandidateMultiplier` | `3` | Candidates generated per requested frame (1–6), capped at 90 total. Higher = better selection, slower. |
| `frameOcrWeight` | `0.4` | Share of the score carried by on-screen text; the rest is sharpness. |

**Cost.** OCR is what selection costs, and it is bounded three ways:

- **A shortlist, not the pool.** Only the top `2 x maxFrames` candidates (hard ceiling 12) are recognized, drawn *through the buckets* so every region of the clip contributes one. The shortlist bounds what gets **read**, never what gets **selected** — see the frame-count note below.
- **A wall-clock budget.** If the pass exceeds 12s the text signal is dropped for *every* candidate at once and a warning says so. Never for some of them — that would rank the recognized frames against zeros and bias the result toward whichever finished first.
- **`frameOcrWeight: 0` skips it entirely.** Weight 0 says text must not influence the ranking, so recognizing it would be pure cost. This is the escape hatch for a long or text-dense video that is taking too long.

Measured on a 6-minute 1080p clip: the legacy extractor runs in 4.1s, smart selection without OCR in 4.4s, and smart selection with OCR in 5.9s. Before the shortlist existed that last figure was 20.0s — recognizing all 60 candidates at 3000px each — which was enough to time out a real export.

In `analyze_video` the results are **reused** by the pipeline's own OCR step rather than recomputed, so selected frames are recognized once, not twice. `get_frames` has never run OCR and still doesn't: its smart mode scores on sharpness and diversity only, which keeps it the fast tool. Use `analyze_video` when the on-screen-text signal matters.

### How many frames do you actually get?

`maxFrames` is a **budget, not a quota**: selection returns up to that many, minus anything that was a near-duplicate of a frame already kept. Fewer frames means the video had that many distinct looks — it is not a failure.

At `detail: "standard"` the budget scales with duration, and an explicit `maxFrames` always wins:

| video duration | default `maxFrames` | ≈ frames per minute |
|---|---|---|
| ≤ 30s | 12 | — |
| ≤ 1 min | 20 | 20 |
| ≤ 3 min | 30 | 10 |
| ≤ 10 min | 45 | 9 at 5 min |
| > 10 min | 60 | 6 at 10 min |

`detail: "detailed"` pins it at 60; `detail: "brief"` extracts no frames at all.

Measured on a 5-minute clip with ordinary visual variation, at the default budget: **45 frames returned, 9 in every single minute** — temporal clustering spreads them evenly by construction. Raising `maxFrames` to 60 gives 60 (12 per minute); lowering it to 20 gives 20 (4 per minute).

The one case that returns noticeably fewer is a video whose frames genuinely are near-identical — a static slide held for minutes, or a synthetic test pattern. On such a clip a 45-frame budget may return 17, because the other 28 carried nothing new. If you want them anyway, raise `frameCandidateMultiplier` (more candidates to choose from) — but the usual reason for a low count is that the extra frames would have been redundant.

**If an export is still too slow**, in rough order of impact: `frameOcrWeight: 0` (skips OCR ranking), `frameSelection: "sceneChange"` (the legacy path), `detail: "brief"` (metadata + transcript, no frames at all), or a smaller `maxFrames`. Whisper transcription of a long video is usually the larger cost — `skipFrames` is not the lever there, `detail: "brief"` is.

`get_frames` reports which selector ran in its `mode` field: `"smart"`, `"scene"`, or `"dense"` (an explicit `dense: true` still wins — asking for uniform coverage gets uniform coverage).

### URL + local-file fallback

YouTube's anti-bot enforcement blocks unauthenticated `yt-dlp` requests to specific videos intermittently and unpredictably — the same command can succeed and then fail minutes later on the same machine ([yt-dlp#12482](https://github.com/yt-dlp/yt-dlp/issues/12482)). Upstream reports the error and stops; recovering means downloading the video by hand and re-running against a local path.

Every video tool — `analyze_video`, `get_transcript`, `get_metadata`, `get_frames`, `analyze_moment`, `get_frame_at`, `get_frame_burst` — now takes an optional `localFallbackPath` alongside `url`:

```jsonc
{
  "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "localFallbackPath": "/Users/me/Movies/jNQXAC9IVRw.mp4"
}
```

The remote source is tried first. If it fails **in a way a local copy can fix**, the same operation is retried against the file, and the response carries a warning naming the original remote error:

```
Remote extraction failed (Video download failed: ERROR: [youtube] …: Sign in to confirm you
are not a bot.) — served this result from localFallbackPath instead.
```

Never silent: the warning is how you know which source actually answered.

- **`url` alone** — unchanged from upstream in every respect.
- **`localFallbackPath` alone** — `url` becomes optional; the local file is read directly with no remote attempt, identical to passing that path as `url`.
- **Neither** — a `UserError`; a source is required.

What counts as "a local copy can fix it": a failed or blocked download, missing yt-dlp, an unusable cookie source, a 4xx/5xx, a DNS or timeout error, a metadata/transcript fetch that failed, or an extraction that produced no frames. What does **not**: an invalid timestamp, a backwards time range, an unsupported URL, a comments fetch that 404'd (a local file has no comments either), or a video that simply has no transcript. Those are reported as themselves rather than retried against a different file — retrying a mistake in the call would only bury the real error under a second copy of it.

The fallback covers both shapes of failure this codebase produces: a thrown error, and — more commonly — a *successful* call that degraded around the failure and explained itself in `warnings[]`. Watching only for exceptions would miss the case it exists for.

CLI equivalent: `--local-fallback <path>`. Not wired into the batch `analyze_videos`, which takes a list of URLs and has no per-item place to put a path.

### Exporting a zip bundle

`export_video_bundle` runs the same analysis as `analyze_video` and writes the result to disk as an ordinary `.zip`:

```
demo.zip
├── frames/
│   ├── 001_0-04.jpg
│   ├── 002_0-11.jpg
│   └── 003_1-02-45.jpg
└── transcript.md
```

Ask for it in the words you'd naturally use — *"export this video"*, *"save the frames"*, *"give me a zip"*, *"put the images in a folder"* — and the agent calls it. It returns the archive's absolute path, its size, and a manifest:

```json
{
  "zipPath": "/Users/you/Desktop/demo.zip",
  "bytes": 65730,
  "frameCount": 5,
  "transcriptEntries": 0,
  "contents": ["frames/001_0-04.jpg", "…", "transcript.md"],
  "warnings": ["…"]
}
```

**The file lands on disk, not in the chat.** An MCP server talks to its client over stdio and cannot hand it a binary payload, so "returns a zip" means "writes a zip and tells you where". Base64-ing a multi-megabyte archive into the response was the alternative — it would cost more context than the analysis it packages and still leave you without a file.

Details worth knowing:

- **Frame names lead with an ordinal**, then the timestamp: `001_0-04.jpg`. A plain alphabetical listing — which is what every file browser shows — is then chronological; a timestamp-first name would sort `10:05` before `9:30`. The `:` becomes `-` because Windows rejects it in filenames.
- **`transcript.md` always exists**, even for a silent clip, where it says so and quotes the reason. A missing file would read as a broken export rather than as a video with no speech. It carries a provenance header (source, platform, duration, uploader, resolution), the timestamped transcript, any OCR'd on-screen text, and the run's warnings.
- **`outputPath`** takes a file path, or a directory (the archive is then named from the video's title), and defaults to the per-user cache dir under `mcp-video-analyzer/bundles/`. It must be absolute — the server's working directory is not predictable from the client.
- **Writes are atomic**: the archive goes to a scratch file and is renamed into place, so an interrupted export never leaves a truncated `.zip` where a good one used to be.
- Accepts every `analyze_video` option (`detail`, `maxFrames`, `maxWidth`, `frameSelection`, …) and the same `localFallbackPath`.

Use `analyze_video` to *answer questions* about a video — it returns the frames inline where the model can see them. `export_video_bundle` deliberately does not, so the agent cannot read the frames it just packaged.

CLI equivalent — `--zip <path>`, which writes the archive in addition to the usual `--out` frame copies:

```bash
node dist/index.js analyze "https://youtu.be/jNQXAC9IVRw" --zip ~/Desktop
```

The archive is built with a small dependency-free ZIP writer (`src/utils/zip.ts`), stored rather than deflated — the payload is JPEG frames, which are already compressed. Its output is verified against the system `unzip` in the test suite, not merely round-tripped through itself.

### Post-Processing Pipeline

After frame extraction, the pipeline automatically applies:

| Step | What it does | Why |
|------|-------------|-----|
| **Frame deduplication** | Removes near-identical consecutive frames using perceptual hashing (dHash + Hamming distance). Runs after [smart selection](#smart-frame-selection), which has already enforced pairwise distinctness across the whole candidate pool. | Screencasts often have long static moments — dedup removes redundant frames, saving tokens |
| **OCR** | Extracts text visible on screen from each frame (via tesseract.js). Each frame is first preprocessed — grayscale + 2× upscale + contrast normalization + sharpen — which materially improves accuracy on stylized overlays (prices, dates, coupons, CTAs). | Captures code, error messages, terminal output, UI text that the transcript doesn't cover |
| **Annotated timeline** | Merges transcript timestamps + frame timestamps + OCR text into a single chronological view | Gives the AI a unified "what was said, what changed visually, and what text appeared" at each moment |

The OCR step requires `tesseract.js` (included as a dependency). If it fails to load, analysis continues without OCR — no frames or transcript are lost. OCR preprocessing is on by default; set `MCP_OCR_PREPROCESS=0` to OCR the raw frames instead.

OCR always reads the **full-resolution** frame, not the copy emitted to the client. The two have different jobs: the emitted frame is capped for token cost, while recognition needs every pixel it can get.

### Frame size (dense UI captures)

Emitted frames are capped at 800 px wide, which suits the common case — talking-head clips, Reels, bug repros — where the subject fills the frame.

It is the wrong size for a **dense UI capture**: a terminal, dashboard, IDE or spreadsheet recording, where the meaning lives in small text. An unscaled 1920×1080 screen recording lands at 800×450, and a 15 px UI font drops below what a vision model can resolve.

Pass `maxWidth` per call to keep more (or all) of the source resolution — `0` disables the cap:

```jsonc
get_frames(url, { maxFrames: 8, maxWidth: 0 })   // source resolution
get_frame_at(url, "2:14", { maxWidth: 1920 })
analyze_video(url, { detail: "standard", maxWidth: 1568 })
```

Supported on `analyze_video`, `analyze_videos`, `analyze_moment`, `get_frames`, `get_frame_at` and `get_frame_burst`, and on the CLI as `--max-width <px>`.

Native frames cost several times more context than the default, so raise the cap deliberately — `get_frames` returns up to 20 frames and `analyze_video` at `detailed` up to 60.

| Variable | Applies to | Default | Notes |
|---|---|---|---|
| `MCP_FRAME_MAX_WIDTH` | Emitted frame width, in px | `800` | `0` (or `native`/`full`/`original`) disables the cap. A per-call `maxWidth` wins over it |
| `MCP_FRAME_JPEG_QUALITY` | Emitted frame JPEG quality | `70` | Raise it when thin glyphs matter; env only, there is no per-call quality parameter. Values outside 1–100 fall back |
| `MCP_CACHE_DIR` | Root for the tessdata cache and the CLI's default `--out` | per-user cache dir | Absolute paths only (a relative value is ignored). Use it when `$HOME` is read-only or absent — a hardened container, `ProtectHome=`, a quota'd home. The published Docker image sets it to `/tmp/mcp-video-analyzer-cache` so `--read-only --tmpfs /tmp` works out of the box |

A value either variable can't use — `1e3`, `1920px`, a quality of `150` — is rejected with a one-time warning on stderr and the default applies. It is not silently accepted: the whole point of the setting is to escape a downscale that otherwise looks like a normal result.

Prefer the per-call parameter: the server starts once per session, so an environment variable cannot differ between an overview of a YouTube clip and a close read of a screen recording. The width a call actually uses is part of the cache and sidecar key, so analyzing the same video at 800 px and then at `maxWidth: 0` re-runs the pipeline instead of returning the first result twice.

## Complementary Tools

### Chrome DevTools MCP

For **live web debugging** alongside video analysis, pair this server with the [Chrome DevTools MCP](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-devtools):

```bash
claude mcp add chrome-devtools npx @anthropic-ai/mcp-devtools@latest
```

**When to use each:**

| Scenario | Tool |
|----------|------|
| Bug report recorded as a Loom video | `mcp-video-analyzer` — extract transcript, frames, and error text from the recording |
| Live debugging a web page | Chrome DevTools MCP — inspect DOM, console, network, take screenshots |
| Video shows UI issue, need to reproduce it | Use both: analyze the video first, then open the page in Chrome DevTools to reproduce |

The two MCPs complement each other: video analyzer understands **recorded** content, DevTools interacts with **live** pages.

## Example Output

The [`examples/loom-demo/`](examples/loom-demo/) folder contains **real outputs** from analyzing a public Loom video ([Boost In-App Demo Video](https://www.loom.com/share/bdebdfe44b294225ac718bad241a94fe), 2:55).

| File | What it shows |
|------|--------------|
| [`metadata.json`](examples/loom-demo/metadata.json) | Title, duration, platform |
| [`transcript.json`](examples/loom-demo/transcript.json) | 42 timestamped entries with speaker IDs |
| [`timeline.json`](examples/loom-demo/timeline.json) | Unified chronological view (transcript + frames merged) |
| [`moment-transcript-0m30s-0m45s.json`](examples/loom-demo/moment-transcript-0m30s-0m45s.json) | Filtered transcript for `analyze_moment` (0:30–0:45) |
| [`full-analysis.json`](examples/loom-demo/full-analysis.json) | Complete `analyze_video` output |

**Frame images** (19 total in [`examples/loom-demo/frames/`](examples/loom-demo/frames/)):
- `scene_*.jpg` — scene-change detection (key visual transitions)
- `dense_*.jpg` — 1fps dense sampling (every 10th frame saved as sample)
- `burst_*.jpg` — burst extraction for moment analysis (0:30–0:45)

> **Regenerate after changes:** `npx tsx examples/generate.ts` — requires yt-dlp + network access.

## Development

```bash
# Install dependencies
npm install

# Run all checks (format, lint, typecheck, knip, tests)
npm run check

# Audit dependencies. `security` covers what the published package ships and
# is a blocking CI job; `security:all` adds devDependencies. Both also run on
# a weekly cron, because npm audit reads a live advisory database.
npm run security

# Build
npm run build

# Run E2E tests (requires network; add WHISPER_E2E=1 to include the
# transcription outcome test — needs a whisper CLI installed)
npm run test:e2e

# Just the video-format matrix: a real clip per container/codec
# (mp4/h264+hevc+av1, webm, mkv, mov, avi, m4v, mpeg, mpg, m2ts, mts,
# 3gp, ogv, flv, wmv) decoded end to end. ~15s on a warm cache; the
# first run fetches ~7MB of tesseract traineddata.
npm run test:formats

# Build + boot the real MCP server/CLI (seconds)
npm run test:smoke

# Everything: check → e2e → smoke → verify-package
npm run verify-all

# Open MCP Inspector for manual testing
npm run inspect
```

## Architecture

```
src/
├── index.ts                    # Entry point (shebang + stdio)
├── server.ts                   # FastMCP server + tool registration
├── tools/                      # MCP tool definitions (7 tools)
│   ├── analyze-video.ts        # Full analysis with detail levels + caching
│   ├── analyze-moment.ts       # Deep-dive on a time range
│   ├── get-transcript.ts       # Transcript-only with Whisper fallback
│   ├── get-metadata.ts         # Metadata + comments + chapters
│   ├── get-frames.ts           # Frames-only (scene-change or dense)
│   ├── get-frame-at.ts         # Single frame at timestamp
│   └── get-frame-burst.ts      # N frames in a time range
├── adapters/                   # Source-specific logic
│   ├── adapter.interface.ts    # IVideoAdapter interface + registry
│   ├── loom.adapter.ts         # Loom: authless GraphQL
│   ├── local-file.adapter.ts   # Local files: absolute path or file:// URI
│   ├── twelvelabs.adapter.ts   # TwelveLabs Pegasus: transcript + AI summary (opt-in)
│   └── direct.adapter.ts       # Direct URL: any mp4/webm link
├── processors/                 # Shared processing
│   ├── frame-extractor.ts      # ffmpeg scene detection + dense + burst extraction
│   ├── browser-frame-extractor.ts # Headless Chrome fallback for frames
│   ├── audio-transcriber.ts    # Whisper fallback (HF transformers → CLI → OpenAI)
│   ├── image-optimizer.ts      # sharp resize/compress
│   ├── frame-dedup.ts          # Perceptual dedup (dHash + Hamming distance)
│   ├── frame-ocr.ts            # OCR text extraction (tesseract.js)
│   └── annotated-timeline.ts   # Unified timeline (transcript + frames + OCR)
├── config/
│   └── detail-levels.ts        # brief / standard / detailed config
├── utils/
│   ├── cache.ts                # In-memory TTL cache with LRU eviction
│   ├── field-filter.ts         # Selective field filtering for responses
│   ├── url-detector.ts         # Platform detection from URL
│   ├── vtt-parser.ts           # WebVTT → transcript entries
│   └── temp-files.ts           # Temp directory management
└── types.ts                    # Shared TypeScript interfaces
```

## License

MIT
