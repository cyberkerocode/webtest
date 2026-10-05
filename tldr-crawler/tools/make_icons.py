"""
One-time local dev helper: generates icons/16.png, icons/48.png, icons/128.png
for the TL;DR Crawler extension using ONLY the Python standard library
(zlib + struct) -- no Pillow, no external tools, nothing shipped with the
extension itself. Produces real, valid PNG files (8-bit RGBA, non-interlaced).

Run with: python tools/make_icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# Palette matching the in-page spider / panel design.
BG = (22, 24, 28, 255)        # #16181c panel background
BLUE = (90, 184, 255, 255)    # #5ab8ff outline / web color
PINK = (255, 79, 122, 255)    # #ff4f7a joint dots
WHITE = (240, 246, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def make_canvas(size):
    return [[TRANSPARENT for _ in range(size)] for _ in range(size)]


def set_px(canvas, x, y, color):
    size = len(canvas)
    if 0 <= x < size and 0 <= y < size:
        canvas[y][x] = color


def blend_px(canvas, x, y, color):
    """Alpha-blend color onto canvas for soft anti-aliased edges."""
    size = len(canvas)
    if not (0 <= x < size and 0 <= y < size):
        return
    a = color[3] / 255.0
    if a >= 1.0:
        canvas[y][x] = color
        return
    bg = canvas[y][x]
    r = int(color[0] * a + bg[0] * (1 - a))
    g = int(color[1] * a + bg[1] * (1 - a))
    b = int(color[2] * a + bg[2] * (1 - a))
    na = max(bg[3], color[3])
    canvas[y][x] = (r, g, b, na)


def fill_circle(canvas, cx, cy, radius, color):
    r2 = radius * radius
    for y in range(int(cy - radius) - 1, int(cy + radius) + 2):
        for x in range(int(cx - radius) - 1, int(cx + radius) + 2):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            d2 = dx * dx + dy * dy
            if d2 <= r2:
                blend_px(canvas, x, y, color)
            elif d2 <= (radius + 1) * (radius + 1):
                # soft edge antialiasing
                edge = (radius + 1) - (d2 ** 0.5)
                if edge > 0:
                    c = (color[0], color[1], color[2], int(color[3] * min(1.0, edge)))
                    blend_px(canvas, x, y, c)


def fill_ellipse(canvas, cx, cy, rx, ry, color):
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            dx = (x + 0.5 - cx) / rx
            dy = (y + 0.5 - cy) / ry
            d2 = dx * dx + dy * dy
            if d2 <= 1.0:
                blend_px(canvas, x, y, color)


def draw_line(canvas, x0, y0, x1, y1, color, width=1):
    # Simple thick line via multiple offset Bresenham passes.
    steps = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
    for i in range(steps + 1):
        t = i / steps if steps else 0
        x = x0 + (x1 - x0) * t
        y = y0 + (y1 - y0) * t
        half = width / 2.0
        for ox in range(-int(half) - 1, int(half) + 2):
            for oy in range(-int(half) - 1, int(half) + 2):
                if ox * ox + oy * oy <= half * half + 0.5:
                    blend_px(canvas, int(round(x + ox)), int(round(y + oy)), color)


def round_rect_bg(canvas, size, radius, color):
    for y in range(size):
        for x in range(size):
            # distance from nearest rounded-rect edge test
            cx = min(max(x, radius), size - 1 - radius)
            cy = min(max(y, radius), size - 1 - radius)
            dx = x - cx
            dy = y - cy
            if dx * dx + dy * dy <= radius * radius or (radius <= x < size - radius) or (radius <= y < size - radius):
                blend_px(canvas, x, y, color)


def draw_spider_icon(size):
    canvas = make_canvas(size)
    s = size / 128.0  # scale factor relative to a 128px design grid

    round_rect_bg(canvas, size, max(2, int(18 * s)), BG)

    cx, cy = size / 2.0, size / 2.0

    # Web strands (radiating lines) behind the spider, subtle.
    web_color = (BLUE[0], BLUE[1], BLUE[2], 90)
    for angle_deg in (20, 70, 110, 160, 200, 250, 290, 340):
        import math
        rad = math.radians(angle_deg)
        x1 = cx + math.cos(rad) * (size * 0.46)
        y1 = cy + math.sin(rad) * (size * 0.46)
        draw_line(canvas, cx, cy, x1, y1, web_color, width=max(1, 1 * s))

    # Legs (drawn before body so body overlaps leg roots)
    leg_color = BLUE
    leg_width = max(1, 2.2 * s)
    abdomen_rx, abdomen_ry = 22 * s, 16 * s
    body_w, body_h = 20 * s, 14 * s

    for side in (-1, 1):
        for i, spread in enumerate((-1.3, -0.5, 0.5, 1.3)):
            hip_x = cx + side * body_w * 0.4
            hip_y = cy - 2 * s
            knee_x = hip_x + side * (16 * s) * (0.6 + abs(spread) * 0.25)
            knee_y = hip_y + spread * 10 * s
            foot_x = knee_x + side * (14 * s)
            foot_y = knee_y + spread * 14 * s + 6 * s
            draw_line(canvas, hip_x, hip_y, knee_x, knee_y, leg_color, leg_width)
            draw_line(canvas, knee_x, knee_y, foot_x, foot_y, leg_color, leg_width)
            # pink joint dots at knee and foot
            fill_circle(canvas, knee_x, knee_y, max(1, 1.6 * s), PINK)
            fill_circle(canvas, foot_x, foot_y, max(1, 1.4 * s), PINK)

    # Abdomen (back ellipse)
    fill_ellipse(canvas, cx + 10 * s, cy + 2 * s, abdomen_rx, abdomen_ry, (18, 20, 24, 255))
    fill_ellipse(canvas, cx + 10 * s, cy + 2 * s, abdomen_rx, abdomen_ry, (0, 0, 0, 0))
    # outline the abdomen with blue stroke by drawing a slightly bigger ellipse behind + smaller fill
    fill_ellipse(canvas, cx + 10 * s, cy + 2 * s, abdomen_rx, abdomen_ry, (*BLUE[:3], 60))
    fill_ellipse(canvas, cx + 10 * s, cy + 2 * s, abdomen_rx * 0.78, abdomen_ry * 0.72, BG)

    # Body (rounded rectangle approximated with ellipse blend)
    fill_ellipse(canvas, cx - 8 * s, cy, body_w * 0.6, body_h * 0.55, BLUE)
    fill_ellipse(canvas, cx - 8 * s, cy, body_w * 0.42, body_h * 0.38, BG)
    fill_ellipse(canvas, cx - 8 * s, cy, body_w * 0.5, body_h * 0.46, (*BLUE[:3], 160))

    # Head with two white eyes
    head_x, head_y = cx - 20 * s, cy - 1 * s
    fill_circle(canvas, head_x, head_y, 9 * s, BLUE)
    fill_circle(canvas, head_x, head_y, 7 * s, BG)
    fill_circle(canvas, head_x - 2.5 * s, head_y - 2 * s, 2.2 * s, WHITE)
    fill_circle(canvas, head_x - 2.5 * s, head_y + 2.6 * s, 2.2 * s, WHITE)

    return canvas


def png_bytes(canvas):
    size = len(canvas)
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (none) per scanline
        for x in range(size):
            r, g, b, a = canvas[y][x]
            raw += bytes((r, g, b, a))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit, RGBA, no interlace
    out = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        canvas = draw_spider_icon(size)
        data = png_bytes(canvas)
        path = os.path.join(OUT_DIR, f"{size}.png")
        with open(path, "wb") as f:
            f.write(data)
        print(f"wrote {path} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
