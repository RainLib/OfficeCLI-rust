import {LocaleType} from '@univerjs/presets'
import type {EditorLocale} from './i18n.tsx'

export function univerLocale(locale: EditorLocale): LocaleType {
  if (locale === 'zh-CN') return LocaleType.ZH_CN
  if (locale === 'zh-TW') return LocaleType.ZH_TW
  if (locale === 'zh-HK') return LocaleType.ZH_HK
  return LocaleType.EN_US
}

export async function loadUniverMessages(locale: EditorLocale) {
  if (locale === 'zh-CN') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-CN'), import('@univerjs/preset-sheets-drawing/locales/zh-CN')])
    return { ...core.default, ...drawing.default }
  }
  if (locale === 'zh-TW') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-TW'), import('@univerjs/preset-sheets-drawing/locales/zh-TW')])
    return { ...core.default, ...drawing.default }
  }
  if (locale === 'zh-HK') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-HK'), import('@univerjs/preset-sheets-drawing/locales/zh-HK')])
    return { ...core.default, ...drawing.default }
  }
  const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/en-US'), import('@univerjs/preset-sheets-drawing/locales/en-US')])
  return { ...core.default, ...drawing.default }
}
