#!/usr/bin/python3

# Camera MJPEG streaming server with motion detection and Telegram notifications.
#
# Combines:
#   - mjpeg_server.py             (MJPEG HTTP streaming)
#   - mjpeg_server_with_rotation.py (EXIF-based stream rotation)
#   - capture_motion_improved.py  (frame-diff motion detection)
#
# Setup:
#   pip3 install simplejpeg requests piexif
#
# Configuration (edit the constants below or export as env vars):
#   TELEGRAM_BOT_TOKEN  - your bot token from @BotFather
#   TELEGRAM_CHAT_ID    - the chat/group ID to send alerts to
#
# Run:
#   python3 mjpeg_stream_motion_telegram.py
#
# Then open http://<pi-ip>:8000 in a browser to watch the live stream.
# A Telegram message + snapshot is sent whenever motion is detected.

import io
import logging
import os
import socketserver
import time
from http import server
from threading import Condition, Thread

import numpy as np
import piexif
import requests

from picamera2 import Picamera2
from picamera2.encoders import H264Encoder, JpegEncoder
from picamera2.outputs import FileOutput, PyavOutput

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")
TELEGRAM_CHAT_ID   = os.environ.get("TELEGRAM_CHAT_ID",   "YOUR_CHAT_ID_HERE")

# HTTP streaming port
STREAM_PORT = 8000

# Low-resolution size used only for motion analysis (keeps CPU load low)
LORES_SIZE = (320, 240)

# Motion sensitivity: higher value → less sensitive (range roughly 1–50)
MOTION_THRESHOLD = 7

# Seconds of no-motion before the video recording stops
MOTION_STOP_DELAY = 2.0

# Minimum seconds between successive Telegram notifications (avoid spam)
TELEGRAM_COOLDOWN = 10.0

# Stream rotation: 0, 90, 180, or 270 degrees (uses EXIF orientation header)
STREAM_ROTATION = 0

# ---------------------------------------------------------------------------
# HTML page served at /index.html
# ---------------------------------------------------------------------------

_W, _H = (480, 640) if STREAM_ROTATION in (90, 270) else (640, 480)

PAGE = f"""\
<html>
<head>
  <title>Picamera2 – Motion Alert Stream</title>
</head>
<body>
  <h1>Picamera2 – Motion Alert Stream</h1>
  <img src="stream.mjpg" width="{_W}" height="{_H}" />
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
    caption = f"Motion detected at {time.strftime('%Y-%m-%d %H:%M:%S')}"
    Thread(target=send_telegram_photo, args=(snapshot_jpeg, caption),
           daemon=True).start()


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
    lsize = LORES_SIZE
    video_config = picam2.create_video_configuration(
        main={"size": (640, 480), "format": "RGB888"},
        lores={"size": lsize, "format": "YUV420"},
    )
    picam2.configure(video_config)

    # MJPEG stream encoder → StreamingOutput
    picam2.start_recording(JpegEncoder(), FileOutput(stream_output))
    logging.info("Camera started – MJPEG stream available at http://<pi-ip>:%d", STREAM_PORT)

    # H.264 encoder for saving motion clips (shared, re-used for each event)
    h264_encoder = H264Encoder(bitrate=1000000)

    # --- HTTP server in background thread ------------------------------------
    http_server = StreamingServer(('', STREAM_PORT), StreamingHandler)
    Thread(target=http_server.serve_forever, daemon=True).start()
    logging.info("HTTP server running on port %d", STREAM_PORT)

    # --- Motion detection loop -----------------------------------------------
    w, h = lsize
    prev = None
    encoding = False
    last_motion_time = 0.0
    last_notify_time = 0.0

    try:
        while True:
            # Grab low-resolution frame for motion analysis
            cur = picam2.capture_array("lores")[:h, :w]

            if prev is not None:
                mse = np.square(np.subtract(cur, prev)).mean()

                if mse > MOTION_THRESHOLD:
                    last_motion_time = time.time()

                    if not encoding:
                        # Start recording the motion clip
                        filename = f"{int(time.time())}.mp4"
                        h264_encoder.output = PyavOutput(filename)
                        picam2.start_encoder(h264_encoder)
                        encoding = True
                        logging.info("Motion detected (MSE=%.1f) – recording %s", mse, filename)

                    # Send Telegram snapshot (rate-limited)
                    now = time.time()
                    if now - last_notify_time > TELEGRAM_COOLDOWN:
                        last_notify_time = now
                        # Grab a full-resolution JPEG snapshot for the notification
                        snapshot = picam2.capture_array("main")
                        # Re-encode snapshot as JPEG using the streaming output buffer
                        with stream_output.condition:
                            stream_output.condition.wait(timeout=1.0)
                            jpeg_bytes = stream_output.frame
                        if jpeg_bytes:
                            notify_motion(jpeg_bytes)

                else:
                    if encoding and (time.time() - last_motion_time) > MOTION_STOP_DELAY:
                        picam2.stop_encoder()
                        encoding = False
                        logging.info("Motion stopped – recording saved.")

            prev = cur

    except KeyboardInterrupt:
        logging.info("Shutting down…")
    finally:
        if encoding:
            picam2.stop_encoder()
        picam2.stop_recording()
        http_server.shutdown()


if __name__ == "__main__":
    main()
