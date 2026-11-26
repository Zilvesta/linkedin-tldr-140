#!/usr/bin/env python3
"""
Generate the extension icons.

Deliberately NOT LinkedIn blue (#0a66c2). A store icon in a platform's exact brand
colour, on an extension whose name contains that platform, edges toward implying
affiliation — which is a Chrome Web Store rejection risk and a trademark one.
This uses an indigo→violet gradient instead: distinct ownership, and it echoes the
gradient bar on the summary card.
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

TOP = (79, 63, 214)       # indigo  #4F3FD6
BOTTOM = (124, 92, 255)   # violet  #7C5CFF
FG = (255, 255, 255, 255)

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def gradient(size):
    """Vertical TOP -> BOTTOM gradient."""
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        g.putpixel((0, y), tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)))
    return g.resize((size, size), Image.BICUBIC)


def make(size):
    # Render at 4x then downsample, so corners and glyphs stay clean.
    s = size * 4

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(gradient(s), (0, 0), mask)

    d = ImageDraw.Draw(img)
    if size >= 32:
        text, font = "140", load_font(int(s * 0.40))
    else:
        # "140" is unreadable at 16px; a bold ellipsis reads as "shortened".
        text, font = "···", load_font(int(s * 0.62))

    box = d.textbbox((0, 0), text, font=font)
    x = (s - (box[2] - box[0])) / 2 - box[0]
    y = (s - (box[3] - box[1])) / 2 - box[1]
    d.text((x, y), text, font=font, fill=FG)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for n in (16, 32, 48, 128):
        make(n).save(os.path.join(OUT, f"icon{n}.png"))
        print(f"icons/icon{n}.png")
