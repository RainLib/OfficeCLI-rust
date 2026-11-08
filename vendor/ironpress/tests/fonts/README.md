# Font test fixtures

`NotoEmoji-TestSubset.ttf` contains only U+2764, U+FE0F, and U+1F600. It is
derived from Noto Emoji at google/fonts commit
`e1118da94a8cb00cf6d06cdac9ef13eb1e5c6ab7` under the SIL Open Font License
in `assets/LICENSE-NotoEmoji.txt`.

Input SHA-256:
`de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`

Output SHA-256:
`aea3849d2006c6edeefb359389d335e9bf5a964846dcd72b2da2c9380e785272`

It was produced with FontTools 4.59.2:

```sh
pyftsubset NotoEmoji-Regular.ttf \
  --unicodes=U+2764,U+FE0F,U+1F600 \
  --output-file=NotoEmoji-TestSubset.ttf \
  --name-IDs='*' --name-legacy --name-languages='*' \
  --layout-features='*' --glyph-names --symbol-cmap --legacy-cmap \
  --notdef-glyph --notdef-outline --recommended-glyphs \
  --no-recalc-timestamp
```
