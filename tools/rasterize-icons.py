#!/usr/bin/env python3
"""Draws the AckWatch application mark and writes every icon the manifest and iOS ask for.

This script is the source of truth for the mark: the SVG and all four PNGs are emitted from the
same geometry below, so they cannot drift apart the way a hand-traced vector and a hand-exported
raster do. It is deliberately not wired into an npm script — it needs Pillow, which is not a
dependency of this project, and the icons change about as often as the product is renamed.

    python3 tools/rasterize-icons.py

The mark is an acknowledgement check in mint on the forest field from the application palette,
with a coral dot for the activity that has not been acknowledged yet.
"""

from PIL import Image, ImageDraw

FOREST = (21, 61, 57)  # --forest #153d39
MINT = (191, 233, 212)  # --mint #bfe9d4
CORAL = (237, 119, 95)  # --coral #ed775f

# Geometry in fractions of the icon's edge, so every size is the same drawing.
CHECK = ((0.26, 0.54), (0.42, 0.69), (0.68, 0.36))
CHECK_WIDTH = 0.092
DOT_CENTER = (0.79, 0.21)
DOT_RADIUS = 0.08
CORNER_RADIUS = 0.22
# A maskable icon may be cropped to a circle by the launcher, so its content is shrunk into the
# safe zone the specification defines rather than running to the edges.
MASKABLE_SCALE = 0.72

SUPERSAMPLE = 8


def draw_mark(size: int, *, rounded: bool, scale: float = 1.0) -> Image.Image:
    """Renders the mark at `size` pixels, supersampled and reduced for clean edges."""
    edge = size * SUPERSAMPLE
    image = Image.new('RGBA', (edge, edge), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if rounded:
        draw.rounded_rectangle(
            (0, 0, edge - 1, edge - 1), radius=CORNER_RADIUS * edge, fill=FOREST
        )
    else:
        draw.rectangle((0, 0, edge - 1, edge - 1), fill=FOREST)

    def place(point: tuple[float, float]) -> tuple[float, float]:
        # Scaled about the centre, so shrinking for the maskable safe zone keeps the mark centred.
        return (
            (0.5 + (point[0] - 0.5) * scale) * edge,
            (0.5 + (point[1] - 0.5) * scale) * edge,
        )

    width = CHECK_WIDTH * scale * edge
    points = [place(point) for point in CHECK]
    draw.line(points, fill=MINT, width=int(width), joint='curve')
    # Round caps: PIL joins segments but leaves the two ends square.
    for end in (points[0], points[-1]):
        draw.ellipse(
            (end[0] - width / 2, end[1] - width / 2, end[0] + width / 2, end[1] + width / 2),
            fill=MINT,
        )

    centre = place(DOT_CENTER)
    radius = DOT_RADIUS * scale * edge
    draw.ellipse(
        (centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius),
        fill=CORAL,
    )

    return image.resize((size, size), Image.LANCZOS)


def svg() -> str:
    check = ' '.join(
        f'{"M" if index == 0 else "L"}{x * 100:.1f} {y * 100:.1f}'
        for index, (x, y) in enumerate(CHECK)
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" '
        'aria-label="AckWatch">\n'
        f'  <rect width="100" height="100" rx="{CORNER_RADIUS * 100:.0f}" fill="#153d39"/>\n'
        f'  <path d="{check}" fill="none" stroke="#bfe9d4" stroke-width="{CHECK_WIDTH * 100:.1f}" '
        'stroke-linecap="round" stroke-linejoin="round"/>\n'
        f'  <circle cx="{DOT_CENTER[0] * 100:.0f}" cy="{DOT_CENTER[1] * 100:.0f}" '
        f'r="{DOT_RADIUS * 100:.0f}" fill="#ed775f"/>\n'
        '</svg>\n'
    )


def main() -> None:
    draw_mark(192, rounded=True).save('public/icon-192.png')
    draw_mark(512, rounded=True).save('public/icon-512.png')
    draw_mark(512, rounded=False, scale=MASKABLE_SCALE).save('public/icon-maskable-512.png')
    # iOS applies its own mask and composites anything transparent onto white, so this one is
    # square and full-bleed rather than rounded.
    draw_mark(180, rounded=False).convert('RGB').save('public/apple-touch-icon.png')
    with open('public/icon.svg', 'w', encoding='utf-8') as handle:
        handle.write(svg())
    print('Wrote public/icon.svg and four PNG icons.')


if __name__ == '__main__':
    main()
