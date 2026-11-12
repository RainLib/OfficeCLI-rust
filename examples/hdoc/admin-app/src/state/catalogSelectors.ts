import type { CatalogFont, ThemeFontSlots, ThemeRevision } from "@/lib/types";

function slotRefs(slots: ThemeFontSlots): string[] {
  return [slots.latin, slots.eastAsia, slots.bidi]
    .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref))
    .map((ref) => ref.fontId);
}

/** Every fontId a theme cites through its six slots. */
export function themeFontIds(theme: ThemeRevision): string[] {
  return [...slotRefs(theme.major), ...slotRefs(theme.minor)];
}

/** fontIds that no theme pins — deletable, but still occupying the catalog. */
export function unreferencedFontIds(themes: ThemeRevision[]): Set<string> {
  const used = new Set<string>();
  for (const theme of themes) {
    for (const fontId of themeFontIds(theme)) used.add(fontId);
  }
  return used;
}

export function unreferencedFonts(
  fonts: CatalogFont[],
  themes: ThemeRevision[],
): string[] {
  const used = unreferencedFontIds(themes);
  return fonts.filter((font) => !used.has(font.fontId)).map((font) => font.fontId);
}
