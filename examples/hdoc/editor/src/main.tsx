import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { PdfExportPreview } from './PdfExportPreview.tsx'

const previewPath = new URLSearchParams(window.location.search).get('pdfPreview')
const validPreview = previewPath && /^\/v1\/downloads\/[0-9a-f-]{36}\/preview$/.test(previewPath)
createRoot(document.getElementById('root')!).render(validPreview ? <PdfExportPreview sourcePath={previewPath} /> : <App />)
