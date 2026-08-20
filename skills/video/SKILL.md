---
name: video
description: Analyze a video (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook, direct URL, or local file) — transcript, key frames, OCR text, metadata, annotated timeline — and answer questions about it with timestamps.
argument-hint: "<video-url-or-path> [question]"
allowed-tools: Bash, Read, mcp__video-analyzer
license: MIT
metadata:
  homepage: https://github.com/ctadros1/mcp-video-analyzer-plus
---

Analyze the given video and answer the user's question (or summarize it if no question was asked). Always cite timestamps (`M:SS`) in your answer.

## Route A — video-analyzer MCP tools available (preferred)

If the `video-analyzer` MCP server is connected in this session, call its tools directly — do not use the CLI:

- General question or no question → `analyze_video` (detail `"standard"`)
- "What happens at X:XX" / a specific moment → `analyze_moment` (time range) or `get_frame_at`
- Question answerable from speech alone → `get_transcript` (fast, no download)
- Title / duration / views / comments only → `get_metadata` (no download)
- Motion or fast UI changes → `get_frame_burst`

**The user has a local copy of a platform video**: pass its absolute path as `localFallbackPath` alongside `url` on any of these tools. YouTube blocks unauthenticated downloads intermittently; the tool then retries against the file automatically and says so in `warnings[]` (`Remote extraction failed (…) — served this result from localFallbackPath instead.`). Passing `localFallbackPath` alone, with no `url`, reads the file directly.

**Frame selection**: frames are chosen by scoring over-sampled candidates on sharpness and on-screen-text density and keeping only visually distinct ones (`frameSelection: "smart"`, the default). Getting fewer frames than `maxFrames` means the video had that many distinct looks — not that extraction failed. Pass `frameSelection: "sceneChange"` for the legacy scene-detector-only path.

**Dense UI capture** (terminal, dashboard, IDE, spreadsheet — the meaning is in small text): pass `maxWidth` on any of these tools. Emitted frames are capped at 800 px wide by default, which turns a 1920×1080 screencast into 800×450 and drops a 15 px UI font below what a vision model can read. `maxWidth: 0` keeps the source resolution; a value like `1568` is the middle ground. Native frames cost several times more context, so raise it for the close read, not for the overview.

## Route B — no MCP server (any agent with a shell)

Run the one-shot CLI via Bash against the local build (progress streams on stderr):

```bash
node /absolute/path/to/mcp-video-analyzer-plus/dist/index.js analyze "<video-url-or-path>"
```

This fork is not published to npm, so there is no `npx` route — the repository must be cloned and built (`npm install && npm run build`) first.

stdout is a single JSON document: `metadata`, `transcript` (timestamped entries), `ocrResults` (on-screen text), `timeline`, `warnings`, and `frames` — an array of `{ time, filePath, mimeType }` pointing to JPEG key frames on disk. Then:

1. Parse the JSON from stdout.
2. Read the `frames[].filePath` images (in parallel) when the question needs visuals.
3. Answer from transcript + OCR + frames, citing timestamps.

Useful flags: `--detail brief|standard|detailed` (brief = metadata + transcript only, no frame extraction — the fast/cheap path), `--fields metadata,transcript` (filters the emitted JSON only; frames are still computed at standard detail), `--max-frames <1-60>`, `--max-width <px>` (frame width cap, default 800; `0` keeps source resolution — use it for dense UI captures whose payload is small text), `--language <code>` (force transcription language), `--out <dir>` (where frames are copied), `--force-refresh`, `--local-fallback <path>` (local copy to use if the remote source is blocked), `--frame-selection smart|sceneChange`. Run `analyze --help` on the built CLI for the full list.

## Prerequisites & degradation

- Node.js 22.12+ (required). `ffmpeg` is bundled — no install needed.
- Platform URLs (YouTube, Instagram, TikTok, …) require `yt-dlp` on PATH; direct `.mp4/.webm/.mov` URLs and local files work without it. Loom transcript, metadata, and comments need no `yt-dlp` either. Loom **frames** usually do — Loom serves most videos as separate DASH video+audio streams that only `yt-dlp` fetches and merges; a CDN fallback covers some videos without it.
- The tool never fails on partial results: the `warnings` array carries actionable hints (yt-dlp install, `YTDLP_COOKIES_FROM_BROWSER` for Instagram/age-restricted, missing Whisper backend). Relay relevant warnings to the user instead of treating them as errors.
- An empty transcript alongside a "silent audio" warning means the video genuinely has no speech (common for muted Reels/Stories) — that is content, not a failure.
