import { emojiCatalog } from './emojiCatalog'
import brushes from '../../../../../crates/canvas-core/assets/brushes.json'
import type { ArtBrush, AvatarMotif, ReactionKind } from './model.ts'

export type BrushId = ArtBrush | 'ink' | 'pencil' | 'marker'
export type HandBrush = { label: string; color: string; strokeWidth: number; opacity: number }
export type MaterialCategory = 'brush' | 'sticker' | 'avatar' | 'reaction' | 'emoji'
export type MaterialSummary = { id: string; category: MaterialCategory; name: string; summary: string }
export type MaterialDetail = MaterialSummary & {
  tags: string[]
  useWhen: string
  avoidWhen: string
  palette: string
  motionDescription?: string
  fallback: string
}
const curatedNames = {
  thumbsUp: '大拇指',
  plusOne: '+1',
  loveIt: '喜欢',
  insight: '有启发',
  done: '完成',
  favorite: '收藏',
  fire: '热烈',
  watch: '关注',
  celebrate: '庆祝',
  smile: '开心',
  launch: '出发',
  action: '行动',
  okay: 'OK 手势',
  question: '有疑问', thumbsDown: '不赞同', dot: '圆点', profile: '我的头像',

}
export const reactionKinds = Object.keys(curatedNames) as ReactionKind[]
export const reactionNames: Record<ReactionKind, string> = Object.assign({}, curatedNames, Object.fromEntries(emojiCatalog.map(row => [row.id, row.name])))
export const isReaction = (id: string): id is ReactionKind => Object.hasOwn(reactionNames, id)
export const isAvatar = (id: unknown): id is AvatarMotif =>
  id === 'mascot' || id === 'moonPal' || id === 'starPal'
const pens = {
  ink: { label: '墨线笔', strokeWidth: 1.5, opacity: 100, color: '$ink' },
  pencil: { label: '铅笔', strokeWidth: 1, opacity: 72, color: '$ink' },
  marker: { label: '荧光笔', strokeWidth: 4.5, opacity: 36, color: '$accent' },
  ...brushes,
}
export const isBrush = (id: string): id is BrushId => Object.hasOwn(pens, id)
export function handBrush(id: BrushId, palette = 'apricot', ink?: string): HandBrush {
  const { label, strokeWidth, opacity, color } = pens[id]
  const accents: Record<string, string> = {
    apricot: '#D48260',
    meadow: '#789A7C',
    lavender: '#A18AB7',
    ocean: '#6C95AD',
  }
  return {
    label,
    strokeWidth,
    opacity,
    color: ink || (color === '$ink' ? '#484439' : accents[palette] || accents.apricot),
  }
}
