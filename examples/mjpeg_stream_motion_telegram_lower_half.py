#!/usr/bin/python3

# Camera MJPEG streaming server with motion detection and Telegram notifications.
#
# Combines:
#   - mjpeg_server.py             (MJPEG HTTP streaming)
#   - mjpeg_server_with_rotation.py (EXIF-based stream rotation)
#   - capture_motion_improved.py  (frame-diff motion detection)
#
# Setup:
#   pip3 install simplejpeg requests piexif pillow
#
# Configuration (in order of precedence):
#   1. examples/telegram.conf  (copy the template and fill in your values)
#   2. Environment variables:  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#
# Run:
#   python3 mjpeg_stream_motion_telegram_lower_half.py
#
# Then open http://<pi-ip>:8000 in a browser to watch the live stream.
# A Telegram message + snapshot is sent whenever motion is detected in
# the lower half of the image (top half is ignored).

import configparser
import io
import logging
import os
import socketserver
import time
from http import server
from pathlib import Path
from threading import Condition, Event, Thread

import numpy as np
import piexif
import requests
from PIL import Image

from picamera2 import Picamera2
from picamera2.encoders import JpegEncoder, MJPEGEncoder
from picamera2.outputs import FileOutput, PyavOutput

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _load_telegram_config() -> tuple[str, str]:
    """Return (bot_token, chat_id) from telegram.conf, then env vars, then placeholders."""
    conf_path = Path(__file__).parent / "telegram.conf"
    if conf_path.exists():
        cfg = configparser.ConfigParser()
        cfg.read(conf_path)
        token = cfg.get("telegram", "bot_token", fallback="")
        chat  = cfg.get("telegram", "chat_id",   fallback="")
        if token and "YOUR_BOT_TOKEN" not in token:
            return token, chat
    return (
        os.environ.get("TELEGRAM_BOT_TOKEN", "YOUR_BOT_TOKEN_HERE"),
        os.environ.get("TELEGRAM_CHAT_ID",   "YOUR_CHAT_ID_HERE"),
    )

TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID = _load_telegram_config()

# HTTP streaming port
STREAM_PORT = 8000

# Main stream resolution for MJPEG HTTP streaming (~3MP, 16:9)
STREAM_SIZE = (2304, 1269)

# Lores stream resolution used for saved motion clips (1080p)
RECORD_SIZE = (1920, 1080)

# Enable HDR mode (requires Camera Module 3 or compatible sensor)
STREAM_HDR = True

# Motion sensitivity: higher value → less sensitive (range roughly 1–50)
MOTION_THRESHOLD = 7

# Fixed duration of each saved motion clip in seconds
MOTION_CLIP_DURATION = 5.0

# Minimum seconds between successive Telegram notifications (avoid spam)
TELEGRAM_COOLDOWN = 10.0

# Stream rotation: 0, 90, 180, or 270 degrees (uses EXIF orientation header)
STREAM_ROTATION = 180

# ---------------------------------------------------------------------------
# HTML page served at /index.html
# ---------------------------------------------------------------------------

PAGE = """\
<html>
<head>
  <title>Voordeur</title>
  <style>
    body { margin: 0; background: #000; }
    h1 { color: #fff; font-family: sans-serif; padding: 8px 12px; margin: 0; }
    img { display: block; width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>Voordeur</h1>
  <img src="stream.mjpg" />
</body>
</html>
"""

# ---------------------------------------------------------------------------
# Streaming output (shared between encoder and HTTP handler)
# ---------------------------------------------------------------------------

def _build_rotation_header(rotation: int) -> bytes:
    """Build an EXIF APP1 segment that encodes the requested JPEG orientation."""
    if not rotation:
        return b""
    code = {90: 6, 180: 3, 270: 8}[rotation]
    exif_bytes = piexif.dump({"0th": {piexif.ImageIFD.Orientation: code}})
    exif_len = len(exif_bytes) + 2  # +2 for the length field itself
    return bytes.fromhex("ffe1") + exif_len.to_bytes(2, "big") + exif_bytes


# Pre-computed once at startup; empty when STREAM_ROTATION == 0
_ROTATION_HEADER = _build_rotation_header(STREAM_ROTATION)


class StreamingOutput(io.BufferedIOBase):
    """Thread-safe buffer that holds the latest JPEG frame.

    When STREAM_ROTATION is non-zero, an EXIF orientation header is injected
    into every frame so that browsers and players rotate the image correctly.
    Supported values: 0 (no rotation), 90, 180, 270.
    """

    def __init__(self):
        self.frame = None
        self.condition = Condition()

    def write(self, buf):
        with self.condition:
            # Inject rotation header between the SOI marker (first 2 bytes)
            # and the rest of the JPEG data
            self.frame = buf[:2] + _ROTATION_HEADER + buf[2:] if _ROTATION_HEADER else buf
            self.condition.notify_all()


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------

class StreamingHandler(server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # silence per-request console noise
        pass

    def do_GET(self):
        if self.path == '/':
            self.send_response(301)
            self.send_header('Location', '/index.html')
            self.end_headers()

        elif self.path == '/index.html':
            content = PAGE.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', len(content))
            self.end_headers()
            self.wfile.write(content)

        elif self.path == '/stream.mjpg':
            self.send_response(200)
            self.send_header('Age', 0)
            self.send_header('Cache-Control', 'no-cache, private')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=FRAME')
            self.end_headers()
            try:
                while True:
                    with stream_output.condition:
                        stream_output.condition.wait()
                        frame = stream_output.frame
                    self.wfile.write(b'--FRAME\r\n')
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', len(frame))
                    self.end_headers()
                    self.wfile.write(frame)
                    self.wfile.write(b'\r\n')
            except Exception as e:
                logging.warning('Streaming client %s disconnected: %s',
                                self.client_address, e)
        else:
            self.send_error(404)
            self.end_headers()


class StreamingServer(socketserver.ThreadingMixIn, server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


# ---------------------------------------------------------------------------
# Notification pause state (toggled by /pause and /resume Telegram commands)
# ---------------------------------------------------------------------------

_notifications_paused = Event()  # set = paused, clear = active


# ---------------------------------------------------------------------------
# Telegram helpers
# ---------------------------------------------------------------------------

def send_telegram_message(text: str) -> None:
    """Send a plain-text message to the configured Telegram chat."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        resp = requests.post(url, data={"chat_id": TELEGRAM_CHAT_ID, "text": text},
                             timeout=10)
        resp.raise_for_status()
    except Exception as e:
        logging.warning("Telegram sendMessage failed: %s", e)


def send_telegram_photo(jpeg_bytes: bytes, caption: str = "") -> None:
    """Send a JPEG snapshot to the configured Telegram chat."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
    try:
        resp = requests.post(
            url,
            data={"chat_id": TELEGRAM_CHAT_ID, "caption": caption},
            files={"photo": ("snapshot.jpg", jpeg_bytes, "image/jpeg")},
            timeout=15,
        )
        resp.raise_for_status()
    except Exception as e:
        logging.warning("Telegram sendPhoto failed: %s", e)


def notify_motion(snapshot_jpeg: bytes) -> None:
    """Fire-and-forget Telegram notification in a background thread."""
    def _send():
        if _notifications_paused.is_set():
            return
        try:
            caption = f"Motion detected at {time.strftime('%Y-%m-%d %H:%M:%S')}"
            img = Image.open(io.BytesIO(snapshot_jpeg)).rotate(180)
            buf = io.BytesIO()
            img.save(buf, format="jpeg")
            send_telegram_photo(buf.getvalue(), caption)
        except Exception as e:
            logging.warning("notify_motion failed: %s", e)
    Thread(target=_send, daemon=True).start()


def poll_telegram_commands() -> None:
    """Background thread: long-poll getUpdates and handle /pause and /resume."""
    offset = 0
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates"
    while True:
        try:
            resp = requests.get(url, params={"timeout": 30, "offset": offset}, timeout=35)
            resp.raise_for_status()
            for update in resp.json().get("result", []):
                offset = update["update_id"] + 1
                text = update.get("message", {}).get("text", "").strip().lower()
                chat_id = update.get("message", {}).get("chat", {}).get("id")
                if text == "/pause":
                    _notifications_paused.set()
                    send_telegram_message("Notifications paused. Send /resume to re-enable.")
                    logging.info("Telegram: notifications paused by user")
                elif text == "/resume":
                    _notifications_paused.clear()
                    send_telegram_message("Notifications resumed.")
                    logging.info("Telegram: notifications resumed by user")
        except Exception as e:
            logging.warning("Telegram poll error: %s", e)
            time.sleep(5)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    if "YOUR_BOT_TOKEN_HERE" in TELEGRAM_BOT_TOKEN:
        logging.warning(
            "Telegram bot token not configured – notifications will fail. "
            "Set the TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables."
        )

    # --- Camera setup -------------------------------------------------------
    global stream_output
    stream_output = StreamingOutput()

    picam2 = Picamera2()
    picam2.set_controls({"AfMode": 2, "AfTrigger": 0})
    hdr_controls = {"HdrMode": 3} if STREAM_HDR else {}  # 3 = SingleExposure HDR
    video_config = picam2.create_video_configuration(
        main={"size": STREAM_SIZE, "format": "RGB888"},
        lores={"size": RECORD_SIZE, "format": "YUV420"},
        controls=hdr_controls,
    )
    picam2.configure(video_config)

    # MJPEG stream encoder → StreamingOutput
    picam2.start_recording(JpegEncoder(), FileOutput(stream_output))
    logging.info("Camera started (HDR=%s) – stream at http://<pi-ip>:%d", STREAM_HDR, STREAM_PORT)

    # MJPEG encoder for saving motion clips from the 1080p lores stream
    mjpeg_encoder = MJPEGEncoder()

    # --- HTTP server in background thread ------------------------------------
    http_server = StreamingServer(('', STREAM_PORT), StreamingHandler)
    Thread(target=http_server.serve_forever, daemon=True).start()
    logging.info("HTTP server running on port %d", STREAM_PORT)

    # --- Telegram command listener -------------------------------------------
    Thread(target=poll_telegram_commands, daemon=True).start()
    logging.info("Telegram command listener started (/pause, /resume)")

    # --- Motion detection loop -----------------------------------------------
    # Mean-pool the 1080p lores Y-plane into 6×6 blocks → ~320×180.
    # Averaging 36 pixels per output pixel suppresses sensor noise (high at night)
    # so only real scene changes push the MSE above the threshold.
    # With STREAM_ROTATION=180, raw top half = displayed bottom half.
    rw, rh = RECORD_SIZE
    prev = None
    encoding = False
    encoding_start = 0.0
    current_filename = ""
    last_notify_time = 0.0

    try:
        while True:
            # Grab lores Y-plane and mean-pool for cheap, noise-resistant analysis
            cur_y = picam2.capture_array("lores")[:rh, :rw]
            cur = cur_y.reshape(rh // 6, 6, rw // 6, 6).mean(axis=(1, 3))

            if prev is not None:
                # Only analyse the lower-right quarter of the displayed image.
                # With STREAM_ROTATION=180 the mapping inverts both axes:
                #   raw top-left  → displayed bottom-right  (the zone we watch)
                half_h = cur.shape[0] // 2
                half_w = cur.shape[1] // 2
                roi_cur  = cur[:half_h, :half_w]
                roi_prev = prev[:half_h, :half_w]
                mse = np.square(np.subtract(roi_cur, roi_prev)).mean()

                if mse > MOTION_THRESHOLD:
                    if not encoding:
                        current_filename = time.strftime("%y-%m-%d_%H:%M") + ".mp4"
                        mjpeg_encoder.output = PyavOutput(current_filename)
                        picam2.start_encoder(mjpeg_encoder, name="lores")
                        encoding = True
                        encoding_start = time.time()
                        logging.info("Motion detected (MSE=%.1f) – recording %s", mse, current_filename)

                    # Send Telegram snapshot (rate-limited)
                    now = time.time()
                    if now - last_notify_time > TELEGRAM_COOLDOWN:
                        last_notify_time = now
                        try:
                            with stream_output.condition:
                                jpeg_bytes = stream_output.frame
                            if jpeg_bytes:
                                notify_motion(jpeg_bytes)
                        except Exception as e:
                            logging.warning("Failed to grab snapshot: %s", e)

            # Stop recording after fixed clip duration
            if encoding and (time.time() - encoding_start) >= MOTION_CLIP_DURATION:
                picam2.stop_encoder(mjpeg_encoder)
                encoding = False
                logging.info("Recording saved – %s", current_filename)

            prev = cur
            # Analyse at ~10 fps — plenty for motion detection and cuts CPU ~3×
            # compared to running at full camera framerate.
            time.sleep(0.1)

    except KeyboardInterrupt:
        logging.info("Shutting down…")
    finally:
        if encoding:
            picam2.stop_encoder(mjpeg_encoder)
        picam2.stop_recording()
        http_server.shutdown()


if __name__ == "__main__":
    main()
