# Builds the aqua skin's taskbar icon from the pixel angel (assets/skins/aqua/angel-source.png):
# zoomed in, kept pixel-sharp, on a pale aqua tile with teal corner brackets.
# Run: python scripts/make-skin-icon.py
from pathlib import Path

from PIL import Image, ImageDraw

DIR = Path(__file__).resolve().parent.parent / 'assets' / 'skins' / 'aqua'
TILE_TOP = (232, 248, 249)
TILE_BOTTOM = (196, 236, 239)
TEAL = (42, 140, 148)
CROP = (70, 120, 400, 450)  # a square around the angel: head, halo and wing
SS = 4


def angel(size: int) -> Image.Image:
    src = Image.open(DIR / 'angel-source.png').convert('RGBA').crop(CROP)
    px = src.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, _ = px[x, y]
            if r > 236 and g > 236 and b > 236:  # the white paper background goes transparent
                px[x, y] = (255, 255, 255, 0)
    return src.resize((size, size), Image.NEAREST)  # nearest-neighbour keeps the pixel art crisp


def icon(size: int) -> Image.Image:
    big = size * SS
    u = big / 100
    tile = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    grad = Image.new('RGBA', (big, big))
    gd = ImageDraw.Draw(grad)
    for y in range(big):
        t = y / (big - 1)
        gd.line([(0, y), (big, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOTTOM)) + (255,))
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=22 * u, fill=255)
    tile.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(tile)
    d.rounded_rectangle([1.5 * u, 1.5 * u, big - 1.5 * u, big - 1.5 * u], radius=20.5 * u, outline=TEAL, width=round(2.2 * u))
    # Corner brackets, like the frame of an old media player screen.
    w = round(3.2 * u)
    for cx, cy, sx, sy in [(14, 14, 1, 1), (86, 14, -1, 1), (14, 86, 1, -1), (86, 86, -1, -1)]:
        x, y = cx * u, cy * u
        d.line([(x, y), (x + sx * 12 * u, y)], fill=TEAL, width=w)
        d.line([(x, y), (x, y + sy * 12 * u)], fill=TEAL, width=w)
    tile = tile.resize((size, size), Image.LANCZOS)
    art = angel(round(size * 0.86))
    off = round((size - art.width) / 2)
    tile.alpha_composite(art, (off, off + round(size * 0.02)))
    return tile


def main() -> None:
    icon(1024).save(DIR / 'icon.png')
    icon(256).save(DIR / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('wrote', DIR / 'icon.png', 'and icon.ico')


if __name__ == '__main__':
    main()
