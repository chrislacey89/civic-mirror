# Brand mark

`mark.svg` is the Civic Mirror icon: a **§**, the section sign, set in Bodoni 72
Bold — cream (`--paper`) on ink (`--ink`), over a saffron (`--highlight`) rule.
Square corners, matching the site's `--radius: 0`.

Why §: it is the glyph of statute and the public record — the thing this site
reads on the town's behalf. It's a Didone form, so it belongs to the same family
as the Playfair masthead. And it has 180° rotational symmetry: the section sign
is its own reflection, which is the "Mirror" half of the name.

The outline is the real Bodoni glyph with a matching `stroke` applied, which
thickens the Didone hairlines just enough to survive a 16px tab strip — the
unstroked glyph greys out at that size.

`mark-maskable.svg` is the same artwork at a smaller optical size so it survives
Android's maskable-icon crop.

## Alternates

`alternates/` holds the other finalists, should the § ever feel too legalistic:

- `ledger.svg` — an open ledger, its saffron gutter the mirror axis. Crispest of
  all the candidates at 16px, and it names the product.
- `ledger-ruled.svg` — same, with ruled entries. Softer below ~24px.
- `eye.svg` — a watchdog eye with a saffron iris. Most legible, least specific.

To adopt one, copy it over `mark.svg` and re-run the commands below.

## Regenerating `public/`

The icon files in `public/` are generated from `mark.svg` and
`mark-maskable.svg` (`public/` also holds `drizzle.svg`, `robots.txt`, and
`manifest.json`, which are not — see `src/lib/icon-inventory.ts` for the
canonical list of generated icons and where each one is referenced):

```bash
rsvg-convert -w 180 -h 180 docs/brand/mark.svg -o public/apple-touch-icon.png
rsvg-convert -w 192 -h 192 docs/brand/mark.svg -o public/icon-192.png
rsvg-convert -w 512 -h 512 docs/brand/mark.svg -o public/icon-512.png
rsvg-convert -w 512 -h 512 docs/brand/mark-maskable.svg -o public/icon-maskable-512.png
cp docs/brand/mark.svg public/favicon.svg

# favicon.ico: render each size natively rather than downscaling one image
for s in 16 32 48; do rsvg-convert -w $s -h $s docs/brand/mark.svg -o /tmp/ico$s.png; done
magick /tmp/ico16.png /tmp/ico32.png /tmp/ico48.png -colors 256 public/favicon.ico
```

Requires `librsvg` and `imagemagick` (`brew install librsvg imagemagick`). The
glyph outline is already baked into `mark.svg` as a path, so Bodoni 72 is not
needed to regenerate — only to redraw from a different character.
