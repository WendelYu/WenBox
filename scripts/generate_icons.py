#!/usr/bin/env python3
"""生成桌面端应用图标集 (macOS .icns / Windows .ico / Tauri PNG)。

图标与 Android 自适应矢量图标保持一致: 深色底 #1E293B + 蓝色上箭头 #3B82F6 + 绿色横条 #10B981。
依赖: pillow (pip3 install --user pillow)。macOS 上生成 .icns 还需要系统自带 iconutil。

用法:
    python3 scripts/generate_icons.py
"""
from PIL import Image, ImageDraw
import os
import subprocess
import sys

BG = (30, 41, 59, 255)       # 1E293B
BLUE = (59, 130, 246, 255)   # 3B82F6
GREEN = (16, 185, 129, 255)  # 10B981

ICON_BASE = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons')


def render(size: int) -> Image.Image:
    S = 4  # 4x 超采样抗锯齿
    big = size * S
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # macOS 风格圆角底板 (圆角半径约 22.4%)
    radius = int(big * 0.224)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BG)

    # 108 视口 -> 圆角底板内容区缩放 (内边距约 8.5%, 与 Android 图标观感一致)
    pad = int(big * 0.085)
    scale = (big - pad * 2) / 108.0
    ox, oy = pad, pad

    def pt(x, y):
        return (ox + x * scale, oy + y * scale)

    # 蓝色上箭头
    arrow = [pt(54, 20), pt(84, 50), pt(66, 50), pt(66, 74), pt(42, 74), pt(42, 50), pt(24, 50)]
    d.polygon(arrow, fill=BLUE)
    # 绿色横条
    d.polygon([pt(24, 80), pt(84, 80), pt(84, 88), pt(24, 88)], fill=GREEN)

    return img.resize((size, size), Image.LANCZOS)


def main():
    base = os.path.abspath(ICON_BASE)
    os.makedirs(f'{base}/icon.iconset', exist_ok=True)

    iconset = {
        'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
        'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
        'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
        'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
        'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
    }
    for name, s in iconset.items():
        render(s).save(f'{base}/icon.iconset/{name}')

    # Tauri 引用的散图
    render(32).save(f'{base}/32x32.png')
    render(128).save(f'{base}/128x128.png')
    render(256).save(f'{base}/128x128@2x.png')
    render(512).save(f'{base}/icon.png')

    # Windows .ico (含多尺寸)
    render(256).save(f'{base}/icon.ico',
                     sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    if sys.platform == 'darwin':
        subprocess.run(['iconutil', '-c', 'icns', f'{base}/icon.iconset', '-o', f'{base}/icon.icns'], check=True)
        print('icon.icns generated')
    print('icons rendered OK')


if __name__ == '__main__':
    main()
