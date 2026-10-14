# Page Video Downloader
 
A Chrome extension (Manifest V3) that detects videos on any web page (including nested iframes, Shadow DOM, and HLS/DASH streaming players), lists them in the toolbar popup, and downloads real playable MP4 video files (.mp4) to your PC.
 
## Install

Works in Google Chrome on Windows and macOS (any Chromium browser with Manifest V3).

 
1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`...\extensions\downloader`).
4. If already installed, click the **Reload** (circular arrow) button on the extension card.
5. Open any page with videos and click the extension icon.
 
## Features & How it works
 
- **Persistent Background Downloads**: Once you start a download, it continues running autonomously in the background even if you close the extension popup, switch tabs, or browse elsewhere. Opening the popup at any time reconnects to the active download and shows live progress.
- **In-Browser HLS to MP4 Remuxer (`hls.js`)**: Picks the best quality, downloads its separate audio playlist too (if the stream has one), downloads 16 segments in parallel while remuxing as they arrive, and writes one `.mp4`. Video and audio share the source's original timeline (including AES-128 streams, discontinuities, MPEG-TS and fMP4), so their relative offset is preserved exactly. No re-encoding.
- **Speed**: Adaptive parallelism (starts at 16 connections, ramps up to 64 while throughput grows, backs off on throttling/errors), stall-based timeouts (15 s with no data) and hedged duplicate requests for slow tail segments. Plain video files are split into byte ranges and fetched in parallel (falls back to the browser download manager when the server doesn't support ranges).
- **No need to press play**: Stream URLs are pulled from page source, API replies and network traffic in every frame (including nested player iframes). The toolbar badge shows the count as soon as something is found, and the popup list updates live while open (some players load their stream 10-15 s after the page opens). If nothing turns up when you open the popup, it starts the page's player **muted** ("Start players silently to find videos", on by default) and pauses it again the moment the stream URL appears, usually within a second, at 0:00 with its sound setting restored. Turn the option off in the popup footer to never touch the player.
- **Resumable segments**: A segment that stalls (no data for 20 s) is resumed with a Range request from where it stopped; failing segments are re-queued up to 4 rounds before the download gives up.
- **Debug log**: The popup's "Debug log" button copies the extension's recent network/detection log to the clipboard.
- **Survives restarts**: The detected-video list and download progress are persisted (`storage` permission), so the popup doesn't lose them when Chrome puts the service worker to sleep.
- **One entry per video**: master playlists, their quality playlists and audio playlists are collapsed into a single list item.
- **Fault-tolerance**: Per-request timeouts and retries; a missing final segment is skipped, any other failed segment stops the download with a clear error instead of silently producing a gap.
- **Universal Multi-Frame Detection**: Injects across all frames (`all_frames: true`) and queries nested iframe players (e.g. YouTube embeds, custom streaming video players) using `webNavigation` and broadcast messaging.
- **Deep DOM & Shadow DOM Scanning**: Recursively inspects Shadow DOM roots and listens for DOM mutations and media playback events.
- **Network Stream Sniffer (`webRequest`)**: Service worker intercepts incoming media playlists and video streams as they load.
- **Strict Video-Only Filtering**: Audio files, tracking pixels, and empty blobs are filtered out so you only see actual videos.
- **Automation page** (popup > Automate): paste one episode URL, choose seasons and episodes (`7`, `1-3`, `1,3,5-8`, or `all`), and it opens each episode in its own unfocused, muted window, grabs the stream the instant it appears, closes the tab, and optionally downloads it. Frames that load late (the real player is often 4 frames deep) are each started silently and re-tried, and the whole thing pauses with a Resume prompt if the site shows a human-verification page (the extension never clicks those).
- **Best quality across servers**: Sites like Nepu offer each episode from many providers (`?server=...`). The popup's **Best quality** button and the Automate page open the episode on several servers at once (default 3), give the others 3 s after the first stream appears, then pick the winner: highest resolution first (from the master playlist, or bitrate when no resolution is listed), then the fastest host (a real segment is timed), then whoever found it first. Results are remembered per server, so reliable high-quality servers are tried first, dead ones drop to last resort, and one slot keeps exploring servers it knows little about. Within a stream the highest-bandwidth variant is always downloaded.
- **Season speed**: Each stream host caps its own speed (measured ~2-4 MB/s per episode stream on Nepu), so Automate downloads several episodes at once ("Downloads at once", default 4) to fill your connection, while finding continues in parallel. Each download's connection count is hill-climbed: it widens while throughput rises and steps back when extra connections stop helping.
- **Burnhouse look**: The popup uses the same charcoal/paper/amber palette and controls as the Burnhouse (dvdburner) app.
- **Rich Popup UI**: Displays file size, video resolution, duration, stream type badges, and one-click "Download Video" / "Copy" buttons.
 
## Usage Tips
 
- If a site uses an interactive or dynamic player, **start playing the video** once so the player initiates network requests; the extension will automatically detect the video stream.
- Click **Download Video** to save the complete `.mp4` video to your Downloads folder. You do not need to keep the extension popup open while it downloads.
- Click **Copy** if you want to copy the direct media URL to your clipboard for external tools.
