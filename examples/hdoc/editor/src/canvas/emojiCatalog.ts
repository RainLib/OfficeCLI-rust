import rows from '../../../../../crates/canvas-core/assets/unicode-emoji.json'
import type { ReactionKind } from './model'

export const emojiGroups = [
  '表情与人物',
  '动物与自然',
  '食物与饮料',
  '活动',
  '旅行与地点',
  '物品',
  '符号',
  '旗帜',
] as const
export type EmojiId = `emoji-${string}`
export const emojiCatalog = (rows as [string, number, string, string][]).map(
  ([glyph, group, zh, en]) => ({
    id: ('emoji-' +
      Array.from(glyph, (c) => c.codePointAt(0)!.toString(16)).join(
        '-',
      )) as EmojiId,
    glyph,
    group,
    name: zh || en,
    english: en,
  }),
)
const byId = new Map<ReactionKind, (typeof emojiCatalog)[number]>(
  emojiCatalog.map((row) => [row.id, row]),
)
export const emojiFor = (id: ReactionKind) => byId.get(id)
