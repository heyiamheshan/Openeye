#!/usr/bin/env python3
"""Render the Openeye landing canvas animation to a 16:9 MP4.

Run:
    python render_demo.py

Output:
    static/openeye-demo.mp4
"""

import cv2
import numpy as np

W, H = 1280, 720          # 16:9 output
CW, CH = 480, 360         # logical canvas size (matches landing.js)
FPS = 30
DURATION = 9              # seconds
OUTPUT = "frontend/static/openeye-demo.mp4"

# Colors (BGR)
BG = np.array([0x11, 0x12, 0x13], dtype=np.uint8)
FLOOR = np.array([0x18, 0x1A, 0x1C], dtype=np.uint8)
SHELF_BACK = np.array([0x21, 0x23, 0x25], dtype=np.uint8)
SHELF = np.array([0x29, 0x2C, 0x2E], dtype=np.uint8)
BOX = np.array([0x34, 0x38, 0x3B], dtype=np.uint8)
MACHINE = np.array([0x25, 0x28, 0x2A], dtype=np.uint8)
MACHINE_PANEL = np.array([0x30, 0x33, 0x36], dtype=np.uint8)
WORKER_ORANGE = np.array([0x16, 0x73, 0xF9], dtype=np.uint8)
WORKER_SKIN = np.array([0x74, 0xBA, 0xFD], dtype=np.uint8)
WORKER_LEGS = np.array([0x12, 0x34, 0x9A], dtype=np.uint8)
ROSE = np.array([0x38, 0x1D, 0xE1], dtype=np.uint8)
WHITE = np.array([0xFF, 0xFF, 0xFF], dtype=np.uint8)
DARK_CARD = np.array([0x17, 0x19, 0x1A], dtype=np.uint8)
TELEGRAM = np.array([0xEE, 0xAB, 0x2A], dtype=np.uint8)
GREY_TEXT = np.array([0x9A, 0x98, 0x95], dtype=np.uint8)
MUTED = np.array([0x89, 0x86, 0x83], dtype=np.uint8)

zone_poly = [
    (280, 140),
    (420, 120),
    (440, 260),
    (300, 290),
]


def clamp(v, a, b):
    return max(a, min(b, v))


def lerp(a, b, t):
    return a + (b - a) * t


def ease_out_cubic(t):
    return 1 - (1 - t) ** 3


def ease_in_out_quad(t):
    if t < 0.5:
        return 2 * t * t
    return 1 - (-2 * t + 2) ** 2 / 2


def pulse(t, freq):
    return np.sin(t * np.pi * 2 * freq) * 0.5 + 0.5


def to_frame(pt):
    """Map logical canvas point to output frame coordinates."""
    x, y = pt
    sx = W / CW
    sy = H / CH
    return int(x * sx), int(y * sy)


def to_ints(pts):
    return [np.array(to_frame(p), dtype=np.int32) for p in pts]


def draw_worker(img, x, y, scale=1.0, moving=False, leg_phase=0, opacity=1.0):
    sx, sy = W / CW, H / CH
    cx, cy = int(x * sx), int(y * sy)
    s = scale * sy

    overlay = img.copy()
    leg_offset = np.sin(leg_phase) * 4 * s if moving else 0

    # Legs
    cv2.line(overlay,
             (cx, cy),
             (int(cx + (-4 + leg_offset) * s), int(cy + 18 * s)),
             WORKER_LEGS.tolist(), int(3 * s), cv2.LINE_AA)
    cv2.line(overlay,
             (cx, cy),
             (int(cx + (4 - leg_offset) * s), int(cy + 18 * s)),
             WORKER_LEGS.tolist(), int(3 * s), cv2.LINE_AA)

    # Body
    cv2.rectangle(overlay,
                  (int(cx - 6 * s), int(cy - 16 * s)),
                  (int(cx + 6 * s), cy),
                  WORKER_ORANGE.tolist(), -1, cv2.LINE_AA)

    # Head
    cv2.circle(overlay, (cx, int(cy - 22 * s)), int(5 * s), WORKER_SKIN.tolist(), -1, cv2.LINE_AA)

    if opacity < 1.0:
        cv2.addWeighted(overlay, opacity, img, 1 - opacity, 0, img)
    else:
        img[:] = overlay


def draw_rounded_rect(img, x1, y1, x2, y2, color, radius):
    color = tuple(int(c) for c in color)
    cv2.rectangle(img, (x1 + radius, y1), (x2 - radius, y2), color, -1)
    cv2.rectangle(img, (x1, y1 + radius), (x2, y2 - radius), color, -1)
    cv2.circle(img, (x1 + radius, y1 + radius), radius, color, -1)
    cv2.circle(img, (x2 - radius, y1 + radius), radius, color, -1)
    cv2.circle(img, (x1 + radius, y2 - radius), radius, color, -1)
    cv2.circle(img, (x2 - radius, y2 - radius), radius, color, -1)


def render_frame(sec):
    img = np.full((H, W, 3), BG, dtype=np.uint8)

    # Phase calculations
    scene_opacity = clamp(sec / 1.5, 0, 1)
    zone_progress = clamp((sec - 2) / 2, 0, 1)
    worker_progress = clamp((sec - 4) / 2, 0, 1)
    breach_pulse = pulse((sec - 4.8) / 1.2, 3) if 4.8 <= sec < 6 else 0
    alert_progress = clamp((sec - 6) / 1, 0, 1)
    telegram_progress = clamp((sec - 7) / 1, 0, 1)
    end_fade = 1 - clamp((sec - 8) / 1, 0, 1)

    alpha = scene_opacity * end_fade
    if alpha <= 0:
        return img

    overlay = img.copy()

    # Floor
    x1, y1 = to_frame((0, 220))
    x2, y2 = to_frame((CW, CH))
    cv2.rectangle(overlay, (x1, y1), (x2, y2), FLOOR.tolist(), -1)

    # Shelves back
    x1, y1 = to_frame((20, 60))
    x2, y2 = to_frame((200, 200))
    cv2.rectangle(overlay, (x1, y1), (x2, y2), SHELF_BACK.tolist(), -1)

    # Shelf columns
    for i in range(4):
        x1, y1 = to_frame((28 + i * 44, 68))
        x2, y2 = to_frame((64 + i * 44, 192))
        cv2.rectangle(overlay, (x1, y1), (x2, y2), SHELF.tolist(), -1)

    # Boxes
    for row in range(3):
        for col in range(3):
            if (row + col) % 3 == 0:
                continue
            x1, y1 = to_frame((34 + col * 44, 78 + row * 36))
            x2, y2 = to_frame((58 + col * 44, 96 + row * 36))
            cv2.rectangle(overlay, (x1, y1), (x2, y2), BOX.tolist(), -1, cv2.LINE_AA)

    # Machine
    x1, y1 = to_frame((360, 90))
    x2, y2 = to_frame((460, 220))
    cv2.rectangle(overlay, (x1, y1), (x2, y2), MACHINE.tolist(), -1)
    x1, y1 = to_frame((370, 105))
    x2, y2 = to_frame((450, 175))
    cv2.rectangle(overlay, (x1, y1), (x2, y2), MACHINE_PANEL.tolist(), -1)
    cx, cy = to_frame((410, 140))
    cv2.circle(overlay, (cx, cy), int(6 * H / CH), ROSE.tolist(), -1, cv2.LINE_AA)

    # Floor line
    p1 = to_frame((0, 280))
    p2 = to_frame((CW, 280))
    cv2.line(overlay, p1, p2, (40, 40, 40), 1, cv2.LINE_AA)

    # Background workers
    draw_worker(overlay, 80, 260, 0.7, False, 0)
    draw_worker(overlay, 170, 110, 0.55, False, 0)

    cv2.addWeighted(overlay, alpha, img, 1 - alpha, 0, img)

    # Zone
    if zone_progress > 0:
        z_overlay = img.copy()
        pts = np.array(to_ints(zone_poly), dtype=np.int32)
        fill_color = np.array(ROSE * (0.08 + breach_pulse * 0.08), dtype=np.uint8)
        cv2.fillPoly(z_overlay, [pts], fill_color.tolist(), cv2.LINE_AA)

        # Stroke progress
        total = len(zone_poly)
        drawn = int(zone_progress * total)
        partial = zone_progress * total - drawn
        stroke_pts = []
        for i in range(min(drawn + 1, total)):
            stroke_pts.append(to_frame(zone_poly[i]))
        if drawn < total and drawn >= 0:
            a = zone_poly[drawn % total]
            b = zone_poly[(drawn + 1) % total]
            px = lerp(a[0], b[0], partial)
            py = lerp(a[1], b[1], partial)
            stroke_pts.append(to_frame((px, py)))
        if len(stroke_pts) > 1:
            thickness = max(1, int((2 + breach_pulse * 2) * H / CH))
            stroke_color = np.array(ROSE * (0.9 + breach_pulse * 0.4), dtype=np.uint8)
            cv2.polylines(z_overlay, [np.array(stroke_pts, dtype=np.int32)], False,
                          stroke_color.tolist(), thickness, cv2.LINE_AA)

        # Label
        if zone_progress >= 0.7:
            label_alpha = clamp((zone_progress - 0.7) / 0.3, 0, 1) * alpha
            cx, cy = to_frame((360, 205))
            txt = "DANGER ZONE"
            font = cv2.FONT_HERSHEY_SIMPLEX
            scale = 0.55 * H / CH
            thickness = max(1, int(1.5 * H / CH))
            (tw, th), _ = cv2.getTextSize(txt, font, scale, thickness)
            label_overlay = z_overlay.copy()
            cv2.putText(label_overlay, txt, (cx - tw // 2, cy + th // 2),
                        font, scale, WHITE.tolist(), thickness, cv2.LINE_AA)
            cv2.addWeighted(label_overlay, label_alpha, z_overlay, 1 - label_alpha, 0, z_overlay)

        cv2.addWeighted(z_overlay, alpha, img, 1 - alpha, 0, img)

    # Moving worker
    if worker_progress > 0:
        wx = lerp(120, 340, ease_in_out_quad(worker_progress))
        wy = lerp(200, 200, ease_in_out_quad(worker_progress))
        leg_phase = worker_progress * 25
        draw_worker(img, wx, wy, 1.0, True, leg_phase, alpha)

    # Alert card
    if alert_progress > 0:
        card_w = int(240 * W / CW)
        card_h = int(110 * H / CH)
        start_x = W + 20
        end_x = W - card_w - int(18 * W / CW)
        x = int(lerp(start_x, end_x, ease_out_cubic(alert_progress)))
        y = int(140 * H / CH)

        a_overlay = img.copy()
        draw_rounded_rect(a_overlay, x, y, x + card_w, y + card_h, WHITE, int(8 * H / CH))
        # Left border
        border_w = max(3, int(5 * W / CW))
        cv2.rectangle(a_overlay, (x, y), (x + border_w, y + card_h), ROSE.tolist(), -1)

        scale = 0.45 * H / CH
        thick = max(1, int(1.5 * H / CH))
        cv2.putText(a_overlay, "Is a person inside the danger zone?",
                    (x + int(18 * W / CW), y + int(26 * H / CH)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale, (0x17, 0x19, 0x1A), thick, cv2.LINE_AA)

        scale2 = 0.38 * H / CH
        thick2 = max(1, int(1 * H / CH))
        cv2.putText(a_overlay, "A worker has entered the restricted",
                    (x + int(18 * W / CW), y + int(50 * H / CH)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale2, (0x5E, 0x53, 0x57), thick2, cv2.LINE_AA)
        cv2.putText(a_overlay, "zone near the machine.",
                    (x + int(18 * W / CW), y + int(66 * H / CH)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale2, (0x5E, 0x53, 0x57), thick2, cv2.LINE_AA)

        cv2.putText(a_overlay, "97% · DANGER ZONE",
                    (x + int(18 * W / CW), y + int(90 * H / CH)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale2, ROSE.tolist(), thick2, cv2.LINE_AA)

        cv2.addWeighted(a_overlay, alpha, img, 1 - alpha, 0, img)

    # Telegram notification
    if telegram_progress > 0:
        card_w = int(220 * W / CW)
        card_h = int(66 * H / CH)
        start_y = -card_h - 20
        end_y = int(18 * H / CH)
        x = W - card_w - int(18 * W / CW)
        y = int(lerp(start_y, end_y, ease_out_cubic(telegram_progress)))

        t_overlay = img.copy()
        draw_rounded_rect(t_overlay, x, y, x + card_w, y + card_h, DARK_CARD, int(10 * H / CH))

        # Telegram icon
        cx, cy = x + int(28 * W / CW), y + card_h // 2
        r = int(14 * H / CH)
        cv2.circle(t_overlay, (cx, cy), r, TELEGRAM.tolist(), -1, cv2.LINE_AA)
        # Paper plane shape (simplified triangle)
        pts = np.array([
            [cx - 5, cy],
            [cx + 5, cy - 5],
            [cx + 2, cy],
            [cx + 5, cy + 5],
        ], dtype=np.int32)
        cv2.fillPoly(t_overlay, [pts], WHITE.tolist(), cv2.LINE_AA)

        scale = 0.38 * H / CH
        thick = max(1, int(1 * H / CH))
        cv2.putText(t_overlay, "Openeye Alert",
                    (x + int(52 * W / CW), y + int(24 * H / CH)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale, WHITE.tolist(), thick, cv2.LINE_AA)
        cv2.putText(t_overlay, "Person in danger zone",
                    (x + int(52 * W / CW), y + int(42 * H / CH)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale, GREY_TEXT.tolist(), thick, cv2.LINE_AA)

        # Thumbnail placeholder
        tx = x + card_w - int(44 * W / CW)
        ty = y + int(13 * H / CH)
        tw = int(32 * W / CW)
        th = int(40 * H / CH)
        cv2.rectangle(t_overlay, (tx, ty), (tx + tw, ty + th), (0x25, 0x28, 0x2A), -1)
        cv2.rectangle(t_overlay, (tx, ty), (tx + tw, ty + th), (60, 60, 60), 1)

        cv2.addWeighted(t_overlay, alpha, img, 1 - alpha, 0, img)

    # Vignette (vectorized)
    cx, cy = W / 2, H / 2
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    mask = np.clip((d - H * 0.4) / (H * 0.5), 0, 1) * 0.45
    vignette = (img * (1 - mask[:, :, np.newaxis])).astype(np.uint8)
    cv2.addWeighted(vignette, 0.7, img, 0.3, 0, img)

    return img


def main():
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(OUTPUT, fourcc, FPS, (W, H))
    if not writer.isOpened():
        raise RuntimeError(f"Could not open video writer for {OUTPUT}")

    total_frames = FPS * DURATION
    for i in range(total_frames):
        sec = (i / FPS) % 9
        frame = render_frame(sec)
        writer.write(frame)
        if i % 30 == 0:
            print(f"Rendering frame {i}/{total_frames} ({100 * i / total_frames:.0f}%)")

    writer.release()
    print(f"Saved {OUTPUT}")


if __name__ == "__main__":
    main()
