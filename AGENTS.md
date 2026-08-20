# AGENTS.md

Instructions for AI agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI, …) using this project as a tool. To work on the codebase itself, see [Contributing to this codebase](#contributing-to-this-codebase) below and [CONTRIBUTING.md](CONTRIBUTING.md).

> Fork of [guimatheus92/mcp-video-analyzer](https://github.com/guimatheus92/mcp-video-analyzer), adding smart frame selection, an automatic URL-to-local-file fallback, and a `.zip` bundle export. **Not published to npm** — build it locally and run `dist/index.js`.

## Analyzing a video

Follow the skill contract — [skills/video/SKILL.md](skills/video/SKILL.md).

Build once, then the one-shot CLI works from any shell (Node 22.12+ only; ffmpeg is bundled):

```bash
npm install && npm run build
node /absolute/path/to/mcp-video-analyzer-plus/dist/index.js analyze "<video-url-or-path>"
```

stdout is a single JSON document (`metadata`, `transcript`, `ocrResults`, `timeline`, `warnings`, and `frames` as `{ time, filePath, mimeType }` → JPEG key frames on disk). Progress goes to stderr. Read the frame images for visual questions; answer with timestamps. `analyze --help` lists all flags.

## MCP alternative

If your agent supports MCP, register the stdio server instead — richer tool set (`analyze_video`, `analyze_moment`, `get_transcript`, `get_metadata`, `get_frames`, `get_frame_at`, `get_frame_burst`, `analyze_videos`, `export_video_bundle`) with frames returned inline:

```json
{ "command": "node", "args": ["/absolute/path/to/mcp-video-analyzer-plus/dist/index.js"] }
```

## Notes

- Platform URLs (YouTube, Instagram, TikTok, …) need `yt-dlp` on PATH; direct `.mp4/.webm/.mov` URLs and local files don't. Loom transcript/metadata/comments don't either. Loom **frames** usually do — most Loom videos are separate DASH video+audio streams that only `yt-dlp` merges; a CDN fallback covers some without it.
- The `warnings` array carries actionable hints (yt-dlp install, cookies via `YTDLP_COOKIES_FROM_BROWSER`, Whisper backends) — relay them, don't treat them as errors.
- Platform URLs get blocked intermittently (YouTube anti-bot). If the user has a local copy of the video, pass its absolute path as `localFallbackPath` alongside `url` and the tool retries against the file automatically. A `Remote extraction failed (…) — served this result from localFallbackPath instead.` warning tells you the file answered, not the URL. CLI equivalent: `--local-fallback <path>`.
- When the user wants the frames or transcript as FILES ("export", "download", "save", "zip", "put the images in a folder"), call `export_video_bundle` — it writes a `.zip` (`frames/` + `transcript.md`) and returns its absolute path. Relay that path: MCP cannot deliver a binary payload in a response. It does NOT return the frames inline, so use `analyze_video` when you need to see them. CLI equivalent: `--zip <path>`.
- Key frames are chosen by smart selection (over-sample, score on sharpness + on-screen text, keep only visually distinct frames). It is the default; pass `frameSelection: "sceneChange"` (CLI `--frame-selection sceneChange`) for the upstream scene-detector-only behaviour. Fewer frames than `maxFrames` is a normal outcome — it means the video had that many distinct looks, not that extraction failed.
- An empty transcript plus a "silent audio" warning means the video has no speech; that's content, not a failure.
- Frames are emitted at 800 px wide by default. For a **dense UI capture** (terminal, dashboard, IDE, spreadsheet) that downscale drops small text below what a vision model can read — pass `maxWidth` on the MCP frame tools (`0` = source resolution), or `--max-width <px>` on the CLI. Native frames cost several times more context, so use it for the close read, not the overview.

## Contributing to this codebase

Read `.claude/skills/video-analyzer-dev/SKILL.md` in full before changing any file in this repository. It is the single source of truth for architecture, conventions, testing rules, verification and the release process — this file intentionally does not repeat it, so that the two can never drift apart. Claude Code loads it as a skill automatically; other agents must open the file directly. See [CONTRIBUTING.md](CONTRIBUTING.md) for human PR and setup steps.

Before modifying code, evaluate each installed skill against the current task. For each skill, determine YES/NO relevance and invoke all YES skills before proceeding.
