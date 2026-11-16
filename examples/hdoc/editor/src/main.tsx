import './standalone.css'
import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { App } from './App.tsx'
import { BusinessEditor } from './BusinessEditor.tsx'
import { PdfExportPreview } from './PdfExportPreview.tsx'
import { I18nProvider, standaloneLocale, useI18n } from './i18n.tsx'

const previewPath = new URLSearchParams(window.location.search).get('pdfPreview')
const validPreview = previewPath && /^\/v1\/downloads\/[0-9a-f-]{36}\/preview$/.test(previewPath)
function StandaloneContent() {
  const { locale, t } = useI18n()
  useEffect(() => {
    document.documentElement.lang = locale
    document.title = t('appTitle')
  }, [locale, t])
  if (validPreview) return <PdfExportPreview sourcePath={previewPath} />
  const businessFile = new URLSearchParams(location.search).get('workspaceFile')
  if (businessFile && /^[a-f0-9-]{36}$/.test(businessFile)) return <BusinessEditor fileId={businessFile} />
  return <App />
}

createRoot(document.getElementById('root')!).render(<I18nProvider initialLocale={standaloneLocale()} persist><StandaloneContent /></I18nProvider>)
