# Draws the abyss "horizon" logo (a chiffon sun sinking below a line, on baltic blue) and writes
# every icon file the app needs. Run: python scripts/make-icon.py
from pathlib import Path

from PIL import Image, ImageDraw

CHIFFON = (0xFF, 0xF6, 0xCA, 255)
BALTIC = (0x33, 0x66, 0x99, 255)
ASSETS = Path(__file__).resolve().parent.parent / 'assets'
SS = 4  # draw 4x larger, then scale down, for smooth edges


def horizon(size: int) -> Image.Image:
    big = size * SS
    u = big / 100  # the design is laid out on a 100x100 grid
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=22 * u, fill=BALTIC)
    # The sun: top half of a circle centred at (50, 62), radius 26.
    d.pieslice([24 * u, 36 * u, 76 * u, 88 * u], start=180, end=360, fill=CHIFFON)
    # The horizon line under it.
    d.rounded_rectangle([18 * u, 68 * u, 82 * u, 74 * u], radius=3 * u, fill=CHIFFON)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    horizon(1024).save(ASSETS / 'icon.png')
    horizon(512).save(ASSETS / 'discord-icon.png')
    horizon(256).save(ASSETS / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    (ASSETS / 'icon.svg').write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<rect width="100" height="100" rx="22" fill="#336699"/>'
        '<path d="M24 62 A26 26 0 0 1 76 62 Z" fill="#FFF6CA"/>'
        '<rect x="18" y="68" width="64" height="6" rx="3" fill="#FFF6CA"/>'
        '</svg>\n',
        encoding='utf8',
    )
    print('wrote icon.png, icon.ico, icon.svg, discord-icon.png to', ASSETS)


if __name__ == '__main__':
    main()
