#!/usr/bin/python3

# Camera MJPEG streaming server with optional stream rotation.
#
# Combines:
#   - mjpeg_server.py               (MJPEG HTTP streaming)
#   - mjpeg_server_with_rotation.py (EXIF-based stream rotation)
#
# Setup:
#   pip3 install simplejpeg piexif
#
# Run:
#   python3 camera_stream.py
#
# Then open http://<pi-ip>:8000 in a browser to watch the live stream.

import io
import logging
import socketserver
from http import server
from threading import Condition

import piexif

from picamera2 import Picamera2
from picamera2.encoders import JpegEncoder
from picamera2.outputs import FileOutput

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# HTTP streaming port
STREAM_PORT = 8000

# Stream rotation: 0, 90, 180, or 270 degrees (uses EXIF orientation header)
STREAM_ROTATION = 180

# ---------------------------------------------------------------------------
# HTML page served at /index.html
# ---------------------------------------------------------------------------

_W, _H = (480, 640) if STREAM_ROTATION in (90, 270) else (960, 720)

PAGE = f"""\
<html>
<head>
  <title>Voordeur</title>
</head>
<body>
  <h1>Voordeur</h1>
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
# Main
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    # --- Camera setup -------------------------------------------------------
    global stream_output
    stream_output = StreamingOutput()

    picam2 = Picamera2()
    video_config = picam2.create_video_configuration(
        main={"size": (640, 480), "format": "RGB888"},
    )
    picam2.configure(video_config)

    # MJPEG stream encoder -> StreamingOutput
    picam2.start_recording(JpegEncoder(), FileOutput(stream_output))
    logging.info("Camera started - MJPEG stream available at http://<pi-ip>:%d", STREAM_PORT)

    # --- HTTP server ---------------------------------------------------------
    http_server = StreamingServer(('', STREAM_PORT), StreamingHandler)
    logging.info("HTTP server running on port %d", STREAM_PORT)

    try:
        http_server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Shutting down...")
    finally:
        picam2.stop_recording()
        http_server.shutdown()


if __name__ == "__main__":
    main()
