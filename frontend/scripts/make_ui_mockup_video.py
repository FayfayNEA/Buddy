"""Generate a short Buddy-style UI mockup product video — screen-filling, not janky."""
from __future__ import annotations

import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np

ROOT = Path(r"C:\Users\Failenn\Desktop\code\consensus-engine\frontend\public\landing")
SRC = ROOT / "ui-mockup.png"
FRAMES_DIR = ROOT / "_ui_video_frames"
OUT_MP4 = ROOT / "ui-mockup-demo.mp4"
OUT_WEBM = ROOT / "ui-mockup-demo.webm"

W, H = 720, 1280
FPS = 24
DURATION = 7.0
N = int(FPS * DURATION)

PURPLE_DEEP = (91, 71, 204)
BG = (242, 240, 249)


def font(size: int, bold: bool = False):
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return a + (b - a) * t


def ease(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def trim_content(img: Image.Image, pad: int = 4) -> Image.Image:
    """Crop away empty / near-white / transparent margins."""
    arr = np.array(img.convert("RGBA"))
    r, g, b, a = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2], arr[:, :, 3]
    # content = opaque enough AND not near-white
    near_white = (r > 248) & (g > 248) & (b > 248)
    content = (a > 20) & (~near_white)
    # also keep light gray UI chrome that isn't pure white
    ys, xs = np.where(content)
    if len(xs) == 0:
        return img
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(img.width - 1, x1 + pad)
    y1 = min(img.height - 1, y1 + pad)
    return img.crop((x0, y0, x1 + 1, y1 + 1))


def recolor_blue_to_purple(img: Image.Image) -> Image.Image:
    arr = np.array(img.convert("RGBA"))
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    mask = (b > 140) & (b > r + 30) & (b > g + 20)
    arr[mask, 0] = np.clip(r[mask] * 0.45 + 124 * 0.55, 0, 255).astype(np.uint8)
    arr[mask, 1] = np.clip(g[mask] * 0.45 + 92 * 0.55, 0, 255).astype(np.uint8)
    arr[mask, 2] = np.clip(b[mask] * 0.30 + 252 * 0.70, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def cover_fit(img: Image.Image, tw: int, th: int) -> Image.Image:
    """Scale to fill width, top-align — keeps the UI readable without giant empty bezels."""
    scale = tw / img.width
    nw, nh = tw, max(1, int(img.height * scale))
    scaled = img.resize((nw, nh), Image.Resampling.LANCZOS)
    # sample a soft bg from the mockup corner
    sample = scaled.getpixel((min(8, nw - 1), min(8, nh - 1)))
    if len(sample) == 3:
        sample = (*sample, 255)
    out = Image.new("RGBA", (tw, th), sample)
    if nh >= th:
        # slight favor toward top so header stays; leave a little bottom crop only if needed
        y0 = 0
        out.paste(scaled.crop((0, y0, tw, y0 + th)), (0, 0))
    else:
        # center vertically on soft bg — no huge letterbox because aspect is close
        out.paste(scaled, (0, (th - nh) // 2), scaled if scaled.mode == "RGBA" else None)
    return out


def draw_phone(screen: Image.Image, y_offset: int = 0) -> Image.Image:
    canvas = Image.new("RGBA", (W, H), (*BG, 255))
    # ambient
    blobs = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blobs)
    bd.ellipse((-140, 180, 340, 660), fill=(124, 92, 252, 40))
    bd.ellipse((400, 720, 920, 1220), fill=(91, 71, 204, 32))
    canvas = Image.alpha_composite(canvas, blobs)

    # phone geometry — taller screen, thin bezel
    px0, py0 = 130, 70 + y_offset
    px1, py1 = W - 130, H - 70 + y_offset

    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (px0 + 12, py0 + 22, px1 + 12, py1 + 22), 52, fill=(29, 26, 36, 55)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(20))
    canvas = Image.alpha_composite(canvas, shadow)

    phone = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(phone)
    d.rounded_rectangle((px0, py0, px1, py1), 52, fill=(18, 18, 22, 255))

    inset = 8
    sx0, sy0 = px0 + inset, py0 + inset
    sx1, sy1 = px1 - inset, py1 - inset
    sw, sh = sx1 - sx0, sy1 - sy0

    # fill screen edge-to-edge (cover)
    fitted = cover_fit(screen.convert("RGBA"), sw, sh)
    # rounded screen mask
    screen_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), 42, fill=255)
    screen_layer.paste(fitted, (sx0, sy0), mask)
    phone = Image.alpha_composite(phone, screen_layer)

    # dynamic island on top of screen
    cx = W // 2
    d = ImageDraw.Draw(phone)
    d.rounded_rectangle((cx - 68, py0 + 18, cx + 68, py0 + 44), 13, fill=(8, 8, 10, 255))

    # thin side buttons hint
    d.rounded_rectangle((px0 - 3, py0 + 160, px0 + 1, py0 + 230), 2, fill=(40, 40, 48, 255))
    d.rounded_rectangle((px1 - 1, py0 + 200, px1 + 3, py0 + 280), 2, fill=(40, 40, 48, 255))

    return Image.alpha_composite(canvas, phone).convert("RGB")


def draw_tap(frame: Image.Image, x: int, y: int, progress: float) -> Image.Image:
    if progress <= 0 or progress >= 1:
        return frame
    overlay = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    r = int(14 + 40 * progress)
    alpha = int(170 * (1 - progress))
    d.ellipse((x - r, y - r, x + r, y + r), outline=(124, 92, 252, alpha), width=3)
    d.ellipse((x - 7, y - 7, x + 7, y + 7), fill=(124, 92, 252, int(190 * (1 - progress))))
    return Image.alpha_composite(frame.convert("RGBA"), overlay).convert("RGB")


def draw_now_playing(frame: Image.Image, t: float) -> Image.Image:
    overlay = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    rise = ease(t)
    bar_h = 84
    y1 = H - 120
    y0 = int(lerp(H + 30, y1 - bar_h, rise))
    a = int(245 * rise)
    d.rounded_rectangle((150, y0, W - 150, y0 + bar_h), 20, fill=(*PURPLE_DEEP, a))
    d.rounded_rectangle((168, y0 + 14, 224, y0 + 70), 12, fill=(255, 255, 255, a))
    d.text((242, y0 + 18), "Blinding Lights", font=font(20, True), fill=(255, 255, 255, a))
    d.text((242, y0 + 46), "The Weeknd", font=font(15), fill=(235, 228, 255, a))
    cx, cy = W - 186, y0 + 42
    d.ellipse((cx - 18, cy - 18, cx + 18, cy + 18), fill=(255, 255, 255, a))
    d.polygon([(cx - 5, cy - 9), (cx - 5, cy + 9), (cx + 10, cy)], fill=(*PURPLE_DEEP, a))
    return Image.alpha_composite(frame.convert("RGBA"), overlay).convert("RGB")


def draw_caption(frame: Image.Image, text: str, opacity: float) -> Image.Image:
    if opacity <= 0.01:
        return frame
    overlay = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    f = font(26, True)
    bbox = d.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    x = (W - tw) // 2
    y = 28
    a = int(255 * opacity)
    d.rounded_rectangle((x - 16, y - 8, x + tw + 16, y + 34), 14, fill=(255, 255, 255, int(220 * opacity)))
    d.text((x, y), text, font=f, fill=(*PURPLE_DEEP, a))
    return Image.alpha_composite(frame.convert("RGBA"), overlay).convert("RGB")


def main():
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    for old in FRAMES_DIR.glob("*.png"):
        old.unlink()

    mock = Image.open(SRC).convert("RGBA")
    mock = trim_content(mock, pad=2)
    print("trimmed mockup size", mock.size)

    for i in range(N):
        t = i / FPS
        y_off = int(5 * math.sin(t * 1.15))

        # slow vertical pan + slight zoom on the UI itself
        zoom = 1.0 + 0.06 * ease(min(1.0, t / 4.0))
        mw, mh = mock.size
        cw, ch = max(1, int(mw / zoom)), max(1, int(mh / zoom))
        max_y = max(0, mh - ch)
        cy = int(max_y * ease(min(1.0, t / 5.0)))
        cx = (mw - cw) // 2
        view = mock.crop((cx, cy, cx + cw, cy + ch))

        frame = draw_phone(view, y_offset=y_off)

        if t < 1.5:
            op = ease(t / 0.35) if t < 0.35 else (1 - ease((t - 1.15) / 0.35) if t > 1.15 else 1)
            frame = draw_caption(frame, "UI mockup, live", op)
        elif 1.7 < t < 3.2:
            op = ease((t - 1.7) / 0.3) if t < 2.0 else (1 - ease((t - 2.85) / 0.35) if t > 2.85 else 1)
            frame = draw_caption(frame, "Tap a track", op)
        elif 3.8 < t < 5.5:
            op = ease((t - 3.8) / 0.3) if t < 4.1 else (1 - ease((t - 5.15) / 0.35) if t > 5.15 else 1)
            frame = draw_caption(frame, "Now playing", op)

        if 2.1 <= t <= 2.9:
            frame = draw_tap(frame, W // 2, int(H * 0.58), (t - 2.1) / 0.8)

        if t >= 3.0:
            frame = draw_now_playing(frame, min(1.0, (t - 3.0) / 0.5))

        if t > DURATION - 0.5:
            fade = 1 - ease((t - (DURATION - 0.5)) / 0.5)
            frame = Image.blend(Image.new("RGB", (W, H), BG), frame, fade)

        frame.save(FRAMES_DIR / f"frame_{i:04d}.png")
        if i % 24 == 0:
            print(f"frame {i}/{N}")

    print("encoding…")
    subprocess.run(
        [
            "ffmpeg", "-y", "-framerate", str(FPS),
            "-i", str(FRAMES_DIR / "frame_%04d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19",
            "-movflags", "+faststart", str(OUT_MP4),
        ],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-framerate", str(FPS),
            "-i", str(FRAMES_DIR / "frame_%04d.png"),
            "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", str(OUT_WEBM),
        ],
        check=False,
    )

    # clean frames
    for old in FRAMES_DIR.glob("*.png"):
        old.unlink()
    FRAMES_DIR.rmdir()
    print("wrote", OUT_MP4, OUT_MP4.stat().st_size)


if __name__ == "__main__":
    main()
