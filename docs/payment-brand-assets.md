# Payment brand assets

The marks shown on the payment row in `src/components/PaymentRally.tsx`. Files live in
`public/payments/`; each method's `logo` path is set in the `METHODS_LIVE` / `METHODS_SOON`
arrays in that component.

## What is installed

| File             | Method     | Source                                        | Licence                    |
| ---------------- | ---------- | --------------------------------------------- | -------------------------- |
| `gcash.svg`      | GCash      | Wikimedia Commons, `File:GCash logo.svg`      | Public domain (PD-textlogo) |
| `maya.svg`       | Maya       | Wikimedia Commons, `File:Maya logo.svg`       | **CC BY 4.0**              |
| `grabpay.svg`    | GrabPay    | `simple-icons` v16.28.0                       | CC0 1.0                    |
| `visa.svg`       | Visa       | `simple-icons` v16.28.0                       | CC0 1.0                    |
| `mastercard.svg` | Mastercard | `simple-icons` v16.28.0                       | CC0 1.0                    |
| `qrph.svg`       | QR Ph      | Wikimedia Commons, `File:QR Ph Logo.svg`      | CC0 1.0                    |

> **Mastercard is the single-colour variant.** `simple-icons` ships one monochrome path,
> rendered here in Mastercard red. The official symbol is two-tone — red and yellow circles
> with an orange overlap. The shape is right and reads correctly at this size, but if you
> want the authentic two-colour mark, take it from the Mastercard Brand Center and drop it
> in over `mastercard.svg`; nothing in the component needs to change.

Each file carries its source and licence as a comment in its own header, so the provenance
travels with the asset.

All six methods now have a real mark. The chip fallback remains in the component: a method
added later without a `logo`, or a path that 404s, falls back to a tinted chip with the
method's initials, so a missing or misnamed file never puts a broken image on the payment
row.

## Attribution obligation — Maya

`maya.svg` is licensed **CC BY 4.0**, which unlike the others *requires* attribution wherever
it is used. The credit is currently carried in the file header and in this document.

> Maya logo © Maya Bank, Inc. / PayMaya Philippines, Inc. — licensed under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), via Wikimedia Commons.

If the site gains a credits or colophon page, put that line there too; a comment inside an
asset is defensible but a visible credit is the safer reading of "reasonable manner". The
obligation ends if the file is replaced with one from Maya's own merchant brand kit, which is
supplied under Maya's terms rather than CC.

## Trade mark note

Public domain or CC covers the *file*, not the *name*. GCash, Maya, GrabPay, Visa,
Mastercard and QR Ph all remain registered trade marks of their owners. Displaying them to
indicate accepted payment methods is ordinary descriptive use, but it depends on the claim
being true — if a method is switched off in the checkout, move it to `METHODS_SOON` or drop
it rather than leaving the mark on the page.

## Rules that come with the files

Every provider licenses its mark on condition the artwork is used **unaltered**: no
redrawing, recolouring, stretching, or rebuilding from scratch. The only edits made here are
mechanical, and none of them touches the artwork itself:

- The `simple-icons` glyphs have their brand `fill` baked in. They ship colourless, and the
  card renders through `<img>`, where CSS cannot reach inside the file to colour them.
- Those three also had their `viewBox` cropped to the ink. `simple-icons` centres every mark
  in a square 24x24 box, so a wide wordmark like Visa carries two thirds of its height as
  empty space — and `object-contain` fits the *box*, which shrank the glyph to a few pixels
  tall. The crop changes the frame, not the geometry, and leaves 2% clear space.
- `qrph.svg` came from Inkscape at 3000x710, already tight to the ink, so only its
  overriding `width`/`height` attributes were removed — left in place they beat the viewBox
  when the file is loaded through `<img>`.
- The Commons files had their XML prolog, DOCTYPE and editor comments stripped.

Two consequences worth knowing:

- **Maya sits on a dark chip.** Its green is `#75EEA5`, which is 1.43:1 on white and
  effectively invisible; Maya's own guidelines present it on dark, where it reaches 11:1.
  The dark backing is the brand-correct treatment, set via `markBg`.
- **Unavailable methods are dimmed, not desaturated.** A grayscale filter would restate a
  mark in colours its owner never authorised; opacity is the ordinary disabled convention
  and leaves the hues intact.

Each kit also specifies a minimum size and clear space. The card renders marks at 28x64px
with `object-contain`; check that against the guidelines before shipping, and enlarge the
card if a kit demands more room.
