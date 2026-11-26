#!/usr/bin/env python3
"""生成全端统一应用图标集 (macOS .icns / Windows .ico / Tauri PNG / Web logo.png / Android 图标)。

基于 scripts/logo-source.png 生成所有尺寸；依赖 pillow (pip3 install --user pillow)。
macOS 上生成 .icns 还需要系统自带 iconutil。

用法:
    python3 scripts/generate_icons.py
"""
from PIL import Image, ImageDraw
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SOURCE_LOGO = os.path.join(os.path.dirname(__file__), 'logo-source.png')
ICON_BASE = os.path.join(ROOT, 'src-tauri', 'icons')
WEB_BASE = os.path.join(ROOT, 'app', 'src', 'main', 'assets', 'web')
RES_BASE = os.path.join(ROOT, 'app', 'src', 'main', 'res')

_SOURCE_IMG = None


def load_source() -> Image.Image:
    global _SOURCE_IMG
    if _SOURCE_IMG is None:
        if not os.path.isfile(SOURCE_LOGO):
            raise FileNotFoundError(f'Missing source logo: {SOURCE_LOGO}')
        img = Image.open(SOURCE_LOGO).convert('RGBA')
        w, h = img.size
        side = min(w, h)
        if w != h:
            img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
        if side != 1024:
            img = img.resize((1024, 1024), Image.LANCZOS)
        _SOURCE_IMG = img
    return _SOURCE_IMG


def render(size: int, round_circle: bool = False) -> Image.Image:
    src = load_source()
    S = 4
    big = size * S
    base = src.resize((big, big), Image.LANCZOS)

    mask = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(mask)
    if round_circle:
        d.ellipse([0, 0, big - 1, big - 1], fill=255)
    else:
        radius = int(big * 0.224)
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)

    out = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def main():
    base = os.path.abspath(ICON_BASE)
    iconset_dir = os.path.join(base, 'icon.iconset')
    os.makedirs(iconset_dir, exist_ok=True)

    iconset = {
        'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
        'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
        'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
        'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
        'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
    }
    for name, s in iconset.items():
        render(s).save(os.path.join(iconset_dir, name))

    # Tauri 引用的散图
    render(32).save(os.path.join(base, '32x32.png'))
    render(128).save(os.path.join(base, '128x128.png'))
    render(256).save(os.path.join(base, '128x128@2x.png'))
    render(512).save(os.path.join(base, 'icon.png'))

    # Windows .ico (含多尺寸)
    render(256).save(
        os.path.join(base, 'icon.ico'),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    # Web SPA / README logo (512px 圆角版)
    os.makedirs(WEB_BASE, exist_ok=True)
    render(512).save(os.path.join(WEB_BASE, 'logo.png'))
    print(f'web logo -> {os.path.join(WEB_BASE, "logo.png")}')

    # Android 自适应前景图与各密度 mipmap 启动图标
    nodpi_dir = os.path.join(RES_BASE, 'drawable-nodpi')
    os.makedirs(nodpi_dir, exist_ok=True)
    load_source().resize((432, 432), Image.LANCZOS).save(
        os.path.join(nodpi_dir, 'ic_launcher_foreground_img.png')
    )
    for density, px in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        mdir = os.path.join(RES_BASE, f'mipmap-{density}')
        os.makedirs(mdir, exist_ok=True)
        render(px).save(os.path.join(mdir, 'ic_launcher.png'))
        render(px, round_circle=True).save(os.path.join(mdir, 'ic_launcher_round.png'))
    print('android launcher icons generated')

    if sys.platform == 'darwin':
        subprocess.run(['iconutil', '-c', 'icns', iconset_dir, '-o', os.path.join(base, 'icon.icns')], check=True)
        print('icon.icns generated')
    shutil.rmtree(iconset_dir, ignore_errors=True)
    print('icons rendered OK')


if __name__ == '__main__':
    main()
