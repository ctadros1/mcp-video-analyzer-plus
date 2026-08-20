import { FastMCP } from 'fastmcp';
import { registerAllAdapters } from './adapters/register.js';
import { registerAnalyzeMoment } from './tools/analyze-moment.js';
import { registerAnalyzeVideo } from './tools/analyze-video.js';
import { registerAnalyzeVideos } from './tools/analyze-videos.js';
import { registerExportVideoBundle } from './tools/export-bundle.js';
import { registerGetFrameAt } from './tools/get-frame-at.js';
import { registerGetFrameBurst } from './tools/get-frame-burst.js';
import { registerGetFrames } from './tools/get-frames.js';
import { registerGetMetadata } from './tools/get-metadata.js';
import { registerGetTranscript } from './tools/get-transcript.js';
import { VERSION } from './version.js';

export function createServer(): FastMCP {
  const server = new FastMCP({
    // The fork's own name, so a client that lists both is not showing two
    // identically-named servers. The per-user cache directory deliberately
    // stays 'mcp-video-analyzer' (temp-files.ts) — renaming it would orphan
    // every already-downloaded tessdata file and cached frame for no gain.
    name: 'mcp-video-analyzer-plus',
    version: VERSION,
    instructions: `Video analysis MCP server. Extracts transcripts, key frames, metadata, comments, OCR text, and annotated timelines from video URLs and local video files.

AUTOMATIC BEHAVIOR — Do NOT wait for the user to ask:
- When the user shares a video URL or local video file path → call analyze_video immediately (detail="standard").
- When discussing a specific moment in a video → call analyze_moment with the time range.
- When the user asks "what happens at X:XX" → call get_frame_at or analyze_moment.
- When the user asks to compare frames or see motion → call get_frame_burst.
- When the transcript alone would answer the question → call get_transcript (faster, no download).
- When only metadata is needed (title, duration, comments) → call get_metadata (no download).
- When the user asks for the frames or transcript as FILES — "export", "download", "save", "zip", "give me the images", "put it in a folder" → call export_video_bundle and give them the returned zipPath.

The AI should ALWAYS call the appropriate tool automatically — never ask "would you like me to analyze this video?" Just do it.

LONG VIDEOS AND TIMEOUTS — read before analyzing anything over a few minutes:
- Frame extraction is fast (about 10s even for a 1080p 6-minute file). TRANSCRIPTION is the slow part: Whisper runs at roughly 3x faster than realtime on CPU, so a 12-minute video takes ~4 minutes and a 30-minute one can take 10+.
- Set expectations BEFORE starting. get_metadata is fast and needs no download — call it first on an unfamiliar video and tell the user the expected wait, then start the analysis.
- The tools emit progress notifications every 10 seconds while transcribing, naming elapsed time. If you are receiving those, the call is healthy — WAIT for it.
- If a call does time out, DO NOT immediately retry with different options. The server keeps working after the client stops waiting, and finished Whisper transcripts are cached per file. Tell the user it is still running, wait, then retry once — the retry reuses the transcript and completes in seconds. Retrying immediately with 'brief' or a lower maxFrames throws away the run in progress and starts over, which is how a working export turns into a loop of timeouts.
- A result with a transcript but no frames does NOT mean frame extraction is broken. detail="brief" skips frames by design; that combination means the timeout hit, not a decode failure.

Supported sources:
- Loom (loom.com/share/...) — transcript, metadata, comments, frames (no auth needed)
- YouTube (watch/shorts/live/youtu.be), Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook — requires yt-dlp installed. Native captions preferred (uploaded > auto-generated), Whisper fallback otherwise; metadata includes uploader/views/chapters; no comments. Instagram and age-restricted videos usually need cookies (YTDLP_COOKIES_FROM_BROWSER=chrome or YTDLP_COOKIES=<file>).
- Direct video URLs (.mp4, .webm, .mov) — frame extraction, duration probing. When TWELVELABS_API_KEY is set, TwelveLabs Pegasus also provides an AI-generated, timestamped transcript (best-effort, not deterministic ASR) + AI summary for these (which direct URLs otherwise lack); prefer get_transcript for a text-only, no-frames answer.
- Local video files — pass an absolute path (e.g., "/Users/you/clip.mp4") or a file:// URI; frame extraction + Whisper transcription work the same way

A silent-but-present audio track (common in muted Reels/Stories) is detected before transcription: the transcript comes back empty with a warning saying so — that is content, not an error.

Tools (choose the most efficient one for the task):
- analyze_video: Full analysis. Use by default when a video URL appears. Returns transcript + frames + metadata + OCR + timeline.
  - detail="brief" → fast, metadata + truncated transcript, no video download
  - detail="standard" → default, scene-change frames + full transcript + OCR
  - detail="detailed" → dense 1fps sampling, more frames, thorough OCR
  - fields=["metadata","transcript"] → return only specific fields
  - Cached for 10min — use forceRefresh=true to re-analyze.
- analyze_videos: Batch version of analyze_video. Use when given a list of sources (e.g. a folder of local files). Runs them with a concurrency limit and returns one structured result per source (counts + warnings, or a per-item error). Pair with MCP_WRITE_SIDECARS=1 for resumable bulk processing.
- get_transcript: Transcript only. Faster than analyze_video when you only need what was said. Whisper fallback for videos without native transcripts.
- get_metadata: Metadata + comments + chapters. No video download needed.
- get_frames: Frames only (scene-change or dense=true for 1fps). Use when you need visuals without transcript.
- get_frame_at: Single frame at a timestamp. Use when the transcript reveals an interesting moment and you want to see it.
- get_frame_burst: N frames in a narrow time range. Use for motion, animations, fast UI changes.
- analyze_moment: Deep-dive on a time range. Combines burst frames + filtered transcript + OCR + mini-timeline. Use when the user asks about a specific part of the video.
- export_video_bundle: Runs the same analysis and packages it as a .zip on disk — frames/ plus transcript.md — returning the archive's absolute path. Use ONLY when the user wants files they can keep; it does not return the frames inline, so you cannot see them. To answer questions about the video, use analyze_video. MCP cannot deliver a binary payload in a response, so always relay the zipPath to the user.

Decision flow:
1. User shares a video URL → analyze_video (standard)
2. User asks about a specific timestamp → analyze_moment or get_frame_at
3. User asks "what did they say about X" → get_transcript (fast, no download)
4. User asks "how long is this video" → get_metadata (fast, no download)
5. User asks for more detail after initial analysis → analyze_video (detailed) or analyze_moment
6. User asks to see motion/animation → get_frame_burst
7. User asks to export/download/save/zip the frames or transcript → export_video_bundle (then give them the zipPath)

Frame selection: frames are chosen by scoring over-sampled candidates on sharpness and on-screen-text density and keeping only the visually distinct ones (options.frameSelection="smart", the default). Fewer frames than maxFrames means the video had that many distinct looks — not that extraction failed. options.frameSelection="sceneChange" restores scene-detector-only behaviour.

Blocked remote sources: every single-video tool takes an optional localFallbackPath (absolute path to a local copy). If the remote source is blocked or unreachable — YouTube anti-bot, missing yt-dlp, network failure — the same operation is retried against that file and warnings[] says so. If a user shares both a link and a local file, pass both.`,
  });

  registerAllAdapters();

  // Register tools
  registerAnalyzeVideo(server);
  registerAnalyzeVideos(server);
  registerGetFrameAt(server);
  registerGetFrameBurst(server);
  registerGetTranscript(server);
  registerGetMetadata(server);
  registerGetFrames(server);
  registerAnalyzeMoment(server);
  registerExportVideoBundle(server);

  return server;
}
