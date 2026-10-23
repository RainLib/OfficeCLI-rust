import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EmbeddedHcdEditor, type HcdEditorLocale } from '@officecli/hcd-reference-editor/react'
import '@officecli/hcd-reference-editor/style.css'
import './style.css'

function Host() {
  const [documentId, setDocumentId] = useState('')
  const [token, setToken] = useState('')
  const [mounted, setMounted] = useState(false)
  const [error, setError] = useState('')
  const [locale, setLocale] = useState<HcdEditorLocale>('en-US')

  return <main className="host">
    <header><strong>Host product</strong><span>HCD editor mounted as an embedded component</span></header>
    <form onSubmit={event => { event.preventDefault(); setError(''); setMounted(true) }}>
      <label>Document ID<input value={documentId} onChange={event => setDocumentId(event.target.value)} required /></label>
      <label>Access token<input value={token} onChange={event => setToken(event.target.value)} type="password" required /></label>
      <label>Editor locale<select value={locale} onChange={event => setLocale(event.target.value as HcdEditorLocale)}>
        <option value="en-US">English (US)</option><option value="en-GB">English (UK)</option>
        <option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文（台灣）</option>
        <option value="zh-HK">繁體中文（香港）</option>
      </select></label>
      <button type="submit">Open embedded editor</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <section className="host-panel">
      {mounted ? <EmbeddedHcdEditor documentId={documentId} token={token} locale={locale} onLocaleChange={setLocale}
        apiUrl="/v1/documents" collabUrl="ws://127.0.0.1:8768"
        onClose={() => setMounted(false)} onError={cause => setError(cause.message)} />
        : <p>Enter a short-lived token issued by the local service above.</p>}
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<Host />)
