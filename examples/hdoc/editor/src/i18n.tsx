import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type EditorLocale = 'en-US' | 'en-GB' | 'zh-CN' | 'zh-TW' | 'zh-HK'

const en = {
  appTitle: 'HCD Document Editor',
  language: 'Language',
  workspaceTitle: 'Document workspace',
  loginHelp: 'Enter a document ID and a short-lived access token. Read-only tokens cannot save changes.',
  documentId: 'Document ID',
  accessToken: 'Access token',
  tokenPlaceholder: 'Paste a short-lived token',
  openDocument: 'Open document',
  openingDocument: 'Opening HCD document…',
  loadingWorkbook: 'Loading workbook…',
  close: 'Close',
  readOnly: 'Read-only',
  editable: 'Editable',
  connecting: 'Connecting',
  connected: 'Connected',
  synced: 'Synced',
  editing: 'Editing',
  saving: 'Saving',
  saveFailed: 'Save failed',
  saved: 'Saved',
  savedSemantic: 'Saved · semantic layout',
  autoSaveRetry: 'Autosave failed; retrying',
  collaborator: 'Collaborator',
  onlineCount: '{count} online',
  onlineCollaborators: 'Online collaborators',
  you: '(you)',
  connectionCount: '{count} windows',
  untitledHeading: 'Untitled heading',
  home: 'Home',
  insert: 'Insert',
  view: 'View',
  revisions: 'Revisions',
  editorFeatures: 'Editor tools',
  settings: 'Settings',
  toolbar: 'Editing toolbar',
  undo: 'Undo',
  redo: 'Redo',
  bodyText: 'Body text',
  heading: 'Heading',
  bold: 'Bold',
  italic: 'Italic',
  link: 'Link',
  bullets: 'Bullets',
  numbering: 'Numbering',
  moveParagraphUp: 'Move paragraph up',
  moveParagraphDown: 'Move paragraph down',
  addParagraph: 'Add paragraph',
  insertHeading: 'Insert heading',
  insertList: 'Insert list',
  insertLink: 'Insert link',
  deleteParagraph: 'Delete paragraph',
  showOutline: 'Show outline',
  readOnlyMode: 'Read-only mode',
  createCheckpoint: 'Create checkpoint',
  saveCheckpoint: 'Save checkpoint',
  viewHistory: 'View revision history',
  currentRevision: 'Current revision r{revision}',
  outline: 'Document outline',
  hideOutline: 'Hide document outline',
  noOutline: 'No headings yet. Turn a paragraph into a heading to add it here.',
  appearance: 'Appearance',
  hidePanel: 'Hide side panel',
  showHeader: 'Show header',
  showToolbar: 'Show toolbar',
  showCollaborators: 'Show collaborators',
  showDocumentOutline: 'Show document outline',
  headerDensity: 'Header density',
  compact: 'Compact',
  standard: 'Standard',
  revisionHistory: 'Revision history',
  semanticExportWarning: 'Exporting DOCX after structural edits rebuilds the semantic layout.',
  imported: 'Imported',
  unknownAuthor: 'Unknown author',
  initialImport: 'Initial import',
  restoredRevision: 'Restored revision',
  editorProjection: 'Editor projection',
  contentUpdated: 'Content updated',
  viewRevision: 'View revision',
  loadOlder: 'Load older revisions',
  revisionContent: 'r{revision} content',
  restoreRevision: 'Restore this revision',
  continuousView: 'Continuous view',
  setLink: 'Set link',
  linkAddress: 'Link URL',
  cancel: 'Cancel',
  applyLink: 'Apply link',
  linkInvalid: 'Links must use http, https, or mailto and be at most 2,048 characters.',
  linkIncomplete: 'Enter a complete http, https, or mailto URL.',
  copySelection: 'Copy selection',
  pasteText: 'Paste text',
  removeLink: 'Remove link',
  setHeading: 'Set as heading',
  setList: 'Set as list',
  newParagraphText: 'New paragraph',
  fixedPreview: 'Fixed-layout preview',
  fragmentSummary: '{count} chunks · pages combined · loaded near viewport',
  indexedFragments: '{loaded} / {total} chunks indexed',
  page: 'Page',
  slide: 'Slide',
  notes: 'Notes',
  missingPageRoot: 'Page chunk has no root element',
  wrongPageChunk: 'Continuation chunk belongs to another page or slide',
  invalidPageSize: 'Page chunk has no valid dimensions',
  assetTooLarge: 'Preview asset exceeds 64 MiB',
  workbookPreview: 'Workbook preview',
  canvasLoading: 'Canvas loads near the viewport',
  sheetWindowLoading: 'Sheets and visible rows load on demand',
  workbookNoSheets: 'Workbook has no visible sheets',
  workbookRequired: 'An HCD/2 workbook is required',
  workbookIndexLimit: 'Workbook index exceeds the safety limit',
  workbookMissingGrid: 'Workbook is missing random-access grid metadata',
  workbookChunkMismatch: 'Workbook chunk ID does not match',
  workbookAssetLimit: 'Workbook chunk exceeds the asset limit',
  workbookAssetMissing: 'Workbook asset {hash} has not loaded',
  exportFormat: 'Export format',
  exportMode: 'Export mode',
  preserveSource: 'Preserve source file',
  semanticRebuild: 'Semantic rebuild',
  export: 'Export',
  exporting: 'Exporting…',
  exported: 'Exported r{revision}',
  revisionUnavailable: 'Document revision has not loaded',
  sourceExportFallback: ' If structure or images changed, choose “Semantic rebuild”.',
  sourceHint: 'Requires the immutable source file on the server. Structural or image changes may prevent source-backed export.',
  semanticHint: 'Rebuilds the current HCD content in the target format. Original pagination and layout may change.',
  sourceLayout: 'Source layout',
  repaginate: 'May repaginate',
  readOnlyComplex: 'Read-only complex content',
} as const

export type MessageKey = keyof typeof en
type Messages = Record<MessageKey, string>

const zhCN: Messages = {
  appTitle: 'HCD 文档编辑器', language: '语言', workspaceTitle: '文档编辑工作台',
  loginHelp: '输入文档 ID 和短期访问令牌。只读令牌无法提交修改。', documentId: '文档 ID',
  accessToken: '访问令牌', tokenPlaceholder: '粘贴短期令牌', openDocument: '打开文档',
  openingDocument: '正在打开 HCD 文档…', loadingWorkbook: '正在加载工作簿…', close: '关闭',
  readOnly: '只读', editable: '可编辑', connecting: '连接中', connected: '已连接', synced: '已同步',
  editing: '编辑中', saving: '保存中', saveFailed: '保存失败', saved: '已保存',
  savedSemantic: '已保存 · 语义版式', autoSaveRetry: '自动保存失败，正在重试',
  collaborator: '协作者', onlineCount: '{count} 人在线', onlineCollaborators: '在线协作者',
  you: '（你）', connectionCount: '{count} 个窗口', untitledHeading: '未命名标题',
  home: '开始', insert: '插入', view: '视图', revisions: '修订', editorFeatures: '编辑功能',
  settings: '界面设置', toolbar: '编辑工具栏', undo: '撤销', redo: '重做', bodyText: '正文',
  heading: '标题', bold: '加粗', italic: '斜体', link: '链接', bullets: '项目符号',
  numbering: '编号', moveParagraphUp: '段落上移', moveParagraphDown: '段落下移',
  addParagraph: '新增段落', insertHeading: '插入标题', insertList: '插入列表', insertLink: '插入链接',
  deleteParagraph: '删除段落', showOutline: '显示大纲', readOnlyMode: '只读模式',
  createCheckpoint: '创建保存点', saveCheckpoint: '保存点', viewHistory: '查看修订历史',
  currentRevision: '当前版本 r{revision}', outline: '文档目录', hideOutline: '隐藏文档目录',
  noOutline: '暂无标题。将段落设为标题后会显示在这里。', appearance: '界面设置',
  hidePanel: '隐藏右侧栏', showHeader: '显示顶部栏', showToolbar: '显示操作栏',
  showCollaborators: '显示协作者', showDocumentOutline: '显示文档目录',
  headerDensity: '头部布局', compact: '紧凑', standard: '标准', revisionHistory: '修订历史',
  semanticExportWarning: '结构编辑后导出 DOCX 将重建语义版式。', imported: '导入',
  unknownAuthor: '作者未记录', initialImport: '初始导入', restoredRevision: '恢复版本',
  editorProjection: '编辑投影', contentUpdated: '内容更新', viewRevision: '查看版本',
  loadOlder: '加载更早的修订', revisionContent: 'r{revision} 内容', restoreRevision: '恢复为此版本',
  continuousView: '连续视图', setLink: '设置链接', linkAddress: '链接地址', cancel: '取消',
  applyLink: '应用链接', linkInvalid: '链接只支持 http、https 或 mailto，且不能超过 2048 个字符',
  linkIncomplete: '请输入完整的 http、https 或 mailto 链接', copySelection: '复制选中内容',
  pasteText: '粘贴文本', removeLink: '移除链接', setHeading: '设为标题', setList: '设为列表',
  newParagraphText: '新段落', fixedPreview: '固定版式预览',
  fragmentSummary: '{count} 个分片 · 同页合成 · 视口按需加载',
  indexedFragments: '已索引 {loaded} / {total} 个分片', page: '页面', slide: '幻灯片',
  notes: '备注', missingPageRoot: '页面分片缺少根节点', wrongPageChunk: '连续分片不属于同一页或幻灯片',
  invalidPageSize: '页面分片缺少有效尺寸', assetTooLarge: '预览资产超过 64 MiB',
  workbookPreview: '工作簿预览', canvasLoading: 'Canvas 按视口加载',
  sheetWindowLoading: '按工作表与可见行窗口加载', workbookNoSheets: '工作簿没有可显示的工作表',
  workbookRequired: '需要 HCD/2 工作簿', workbookIndexLimit: '工作簿索引页超过安全上限',
  workbookMissingGrid: '工作簿缺少 grid 随机访问元数据', workbookChunkMismatch: '工作簿分片 ID 不匹配',
  workbookAssetLimit: '工作簿分片资产数量超过安全上限', workbookAssetMissing: '未加载工作簿资产 {hash}',
  exportFormat: '导出格式', exportMode: '导出方式', preserveSource: '保留原文件',
  semanticRebuild: '语义重建', export: '导出', exporting: '导出中…', exported: '已导出 r{revision}',
  revisionUnavailable: '文档修订尚未加载',
  sourceExportFallback: '。如已调整结构或图片，请选择“语义重建”。',
  sourceHint: '需要服务器保存不可变原文件；结构编辑或图片修改可能无法源文件回写',
  semanticHint: '将当前 HCD 内容重建为目标格式，原始分页和版式可能变化',
  sourceLayout: '保留源版式', repaginate: '将重新排版', readOnlyComplex: '只读复杂内容',
}

const zhTW: Messages = {
  appTitle: 'HCD 文件編輯器', language: '語言', workspaceTitle: '文件編輯工作區',
  loginHelp: '輸入文件 ID 和短期存取權杖。唯讀權杖無法儲存變更。', documentId: '文件 ID',
  accessToken: '存取權杖', tokenPlaceholder: '貼上短期權杖', openDocument: '開啟文件',
  openingDocument: '正在開啟 HCD 文件…', loadingWorkbook: '正在載入活頁簿…', close: '關閉',
  readOnly: '唯讀', editable: '可編輯', connecting: '連線中', connected: '已連線', synced: '已同步',
  editing: '編輯中', saving: '儲存中', saveFailed: '儲存失敗', saved: '已儲存',
  savedSemantic: '已儲存 · 語意版面', autoSaveRetry: '自動儲存失敗，正在重試',
  collaborator: '協作者', onlineCount: '{count} 人在線', onlineCollaborators: '在線協作者',
  you: '（你）', connectionCount: '{count} 個視窗', untitledHeading: '未命名標題',
  home: '開始', insert: '插入', view: '檢視', revisions: '修訂', editorFeatures: '編輯功能',
  settings: '介面設定', toolbar: '編輯工具列', undo: '復原', redo: '重做', bodyText: '內文',
  heading: '標題', bold: '粗體', italic: '斜體', link: '連結', bullets: '項目符號',
  numbering: '編號', moveParagraphUp: '段落上移', moveParagraphDown: '段落下移',
  addParagraph: '新增段落', insertHeading: '插入標題', insertList: '插入清單', insertLink: '插入連結',
  deleteParagraph: '刪除段落', showOutline: '顯示大綱', readOnlyMode: '唯讀模式',
  createCheckpoint: '建立儲存點', saveCheckpoint: '儲存點', viewHistory: '檢視修訂記錄',
  currentRevision: '目前版本 r{revision}', outline: '文件大綱', hideOutline: '隱藏文件大綱',
  noOutline: '尚無標題。將段落設為標題後會顯示於此。', appearance: '介面設定',
  hidePanel: '隱藏側邊欄', showHeader: '顯示頂端列', showToolbar: '顯示工具列',
  showCollaborators: '顯示協作者', showDocumentOutline: '顯示文件大綱',
  headerDensity: '標頭密度', compact: '精簡', standard: '標準', revisionHistory: '修訂記錄',
  semanticExportWarning: '結構編輯後匯出 DOCX 將重建語意版面。', imported: '匯入',
  unknownAuthor: '作者不詳', initialImport: '初始匯入', restoredRevision: '還原版本',
  editorProjection: '編輯投影', contentUpdated: '內容已更新', viewRevision: '檢視版本',
  loadOlder: '載入較早的修訂', revisionContent: 'r{revision} 內容', restoreRevision: '還原為此版本',
  continuousView: '連續檢視', setLink: '設定連結', linkAddress: '連結網址', cancel: '取消',
  applyLink: '套用連結', linkInvalid: '連結僅支援 http、https 或 mailto，且不可超過 2048 個字元',
  linkIncomplete: '請輸入完整的 http、https 或 mailto 網址', copySelection: '複製選取內容',
  pasteText: '貼上文字', removeLink: '移除連結', setHeading: '設為標題', setList: '設為清單',
  newParagraphText: '新段落', fixedPreview: '固定版面預覽',
  fragmentSummary: '{count} 個片段 · 同頁合併 · 視窗按需載入',
  indexedFragments: '已索引 {loaded} / {total} 個片段', page: '頁面', slide: '投影片',
  notes: '備註', missingPageRoot: '頁面片段缺少根節點', wrongPageChunk: '接續片段不屬於同一頁或投影片',
  invalidPageSize: '頁面片段缺少有效尺寸', assetTooLarge: '預覽資產超過 64 MiB',
  workbookPreview: '活頁簿預覽', canvasLoading: 'Canvas 依視窗載入',
  sheetWindowLoading: '依工作表及可見列載入', workbookNoSheets: '活頁簿沒有可顯示的工作表',
  workbookRequired: '需要 HCD/2 活頁簿', workbookIndexLimit: '活頁簿索引頁超過安全上限',
  workbookMissingGrid: '活頁簿缺少 grid 隨機存取中繼資料', workbookChunkMismatch: '活頁簿片段 ID 不符',
  workbookAssetLimit: '活頁簿片段資產數量超過安全上限', workbookAssetMissing: '尚未載入活頁簿資產 {hash}',
  exportFormat: '匯出格式', exportMode: '匯出方式', preserveSource: '保留原始檔',
  semanticRebuild: '語意重建', export: '匯出', exporting: '匯出中…', exported: '已匯出 r{revision}',
  revisionUnavailable: '文件修訂尚未載入',
  sourceExportFallback: '。若已調整結構或圖片，請選擇「語意重建」。',
  sourceHint: '伺服器須保存不可變原始檔；結構或圖片變更可能無法回寫原始檔',
  semanticHint: '依目前 HCD 內容重建目標格式，原始分頁及版面可能改變',
  sourceLayout: '保留原始版面', repaginate: '可能重新分頁', readOnlyComplex: '唯讀複雜內容',
}

const dictionaries = { en, zhCN, zhTW }
const chineseKeys = new Map<string, MessageKey>(
  (Object.keys(zhCN) as MessageKey[]).map(key => [zhCN[key], key]),
)

export function translateChineseSource(locale: EditorLocale, source: string): string | null {
  if (locale === 'zh-CN') return source
  const key = chineseKeys.get(source)
  return key ? translate(locale, key) : null
}
export const localeOptions: ReadonlyArray<{ value: EditorLocale; label: string }> = [
  { value: 'en-US', label: 'English (US)' }, { value: 'en-GB', label: 'English (UK)' },
  { value: 'zh-CN', label: '简体中文' }, { value: 'zh-TW', label: '繁體中文（台灣）' },
  { value: 'zh-HK', label: '繁體中文（香港）' },
]

export function normalizeLocale(value?: string | null): EditorLocale {
  const tag = value?.trim().replaceAll('_', '-').toLowerCase()
  if (tag === 'en-gb') return 'en-GB'
  if (tag === 'zh-hk' || tag === 'zh-mo') return 'zh-HK'
  if (tag === 'zh-tw' || tag === 'zh-hant' || tag?.startsWith('zh-hant-')) return 'zh-TW'
  if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-sg' || tag?.startsWith('zh-hans')) return 'zh-CN'
  return 'en-US'
}

export function translate(locale: EditorLocale, key: MessageKey, values?: Record<string, string | number>): string {
  const group = locale.startsWith('en') ? 'en' : locale === 'zh-CN' ? 'zhCN' : 'zhTW'
  const template: string = dictionaries[group][key]
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`))
}

type I18nValue = { locale: EditorLocale; setLocale: (locale: EditorLocale) => void; t: typeof translateBound }
function translateBound(key: MessageKey, values?: Record<string, string | number>): string {
  return translate('en-US', key, values)
}
const I18nContext = createContext<I18nValue | null>(null)

export function standaloneLocale(): EditorLocale {
  const query = new URLSearchParams(window.location.search)
  const configured = query.get('locale') || query.get('lang')
  if (configured) return normalizeLocale(configured)
  try { return normalizeLocale(localStorage.getItem('hcd-editor-locale')) } catch { return 'en-US' }
}

export function I18nProvider({ initialLocale, persist = false, onLocaleChange, children }: {
  initialLocale?: string; persist?: boolean; onLocaleChange?: (locale: EditorLocale) => void; children: ReactNode
}) {
  const [locale, updateLocale] = useState<EditorLocale>(() => normalizeLocale(initialLocale))
  useEffect(() => { if (initialLocale) updateLocale(normalizeLocale(initialLocale)) }, [initialLocale])
  const setLocale = useCallback((next: EditorLocale) => {
    updateLocale(next)
    if (persist) {
      try { localStorage.setItem('hcd-editor-locale', next) } catch { /* private browsing */ }
      const url = new URL(window.location.href)
      if (url.searchParams.has('locale') || url.searchParams.has('lang')) {
        url.searchParams.delete('lang')
        url.searchParams.set('locale', next)
        window.history.replaceState(null, '', url)
      }
    }
    onLocaleChange?.(next)
  }, [persist, onLocaleChange])
  const t = useCallback((key: MessageKey, values?: Record<string, string | number>) => translate(locale, key, values), [locale])
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('HCD i18n provider is missing')
  return value
}

export function LocaleSelect() {
  const { locale, setLocale, t } = useI18n()
  return <label className="locale-switcher">{t('language')}<select aria-label={t('language')} value={locale}
    onChange={event => setLocale(event.target.value as EditorLocale)}>
    {localeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>
}
