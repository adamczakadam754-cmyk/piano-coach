"""Draws the app icon (gradient tile with piano keys) as PNGs for the iPhone/iPad home screen.

    python tools/make_icons.py      # writes web/icons/icon-180.png, icon-192.png, icon-512.png

No image library needed: the shapes are drawn with numpy and saved with a tiny PNG writer.
iOS rounds the corners itself, so the tile is a full square.
"""
import struct
import zlib
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"


def rounded_rect(xx, yy, x0, y0, x1, y1, r):
    """Mask of a rounded rectangle on a coordinate grid."""
    cx = np.clip(xx, x0 + r, x1 - r)
    cy = np.clip(yy, y0 + r, y1 - r)
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r


def draw(size: int) -> np.ndarray:
    ss = 4  # supersampling for smooth edges
    n = size * ss
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64) / n  # 0..1 coordinates
    # Diagonal gradient: violet (#8b5cf6) -> indigo (#6366f1) -> cyan (#06b6d4)
    t = np.clip((xx + yy) / 2, 0, 1)[..., None]
    a, b, c = (np.array(v, float) for v in ((139, 92, 246), (99, 102, 241), (6, 182, 212)))
    img = np.where(t < 0.45, a + (b - a) * (t / 0.45), b + (c - b) * ((t - 0.45) / 0.55))
    # Soft light from the top-left.
    img = img + 40 * np.clip(1 - np.hypot(xx - 0.2, yy - 0.15) / 0.8, 0, 1)[..., None]

    white = np.array((255, 255, 255), float)
    black = np.array((30, 27, 75), float)
    for i in range(4):  # four white keys
        x0 = 0.22 + i * 0.145
        img[rounded_rect(xx, yy, x0, 0.25, x0 + 0.125, 0.75, 0.04)] = white
    for x0 in (0.315, 0.605):  # two black keys
        img[rounded_rect(xx, yy, x0, 0.25, x0 + 0.095, 0.53, 0.025)] = black

    img = img.clip(0, 255).reshape(size, ss, size, ss, 3).mean(axis=(1, 3))
    return np.dstack([img, np.full((size, size), 255.0)]).round().astype(np.uint8)


def write_png(path: Path, rgba: np.ndarray) -> None:
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (180, 192, 512):
        write_png(OUT / f"icon-{size}.png", draw(size))
        print(f"web/icons/icon-{size}.png")
