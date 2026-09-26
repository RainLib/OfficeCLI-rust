import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EmbeddedHcdEditor } from '@officecli/hcd-reference-editor/react'
import '@officecli/hcd-reference-editor/style.css'
import './style.css'

function Host() {
  const [documentId, setDocumentId] = useState('')
  const [token, setToken] = useState('')
  const [mounted, setMounted] = useState(false)
  const [error, setError] = useState('')

  return <main className="host">
    <header><strong>宿主产品</strong><span>HCD 编辑器以内嵌组件运行</span></header>
    <form onSubmit={event => { event.preventDefault(); setError(''); setMounted(true) }}>
      <label>文档 ID<input value={documentId} onChange={event => setDocumentId(event.target.value)} required /></label>
      <label>访问令牌<input value={token} onChange={event => setToken(event.target.value)} type="password" required /></label>
      <button type="submit">打开内嵌编辑器</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <section className="host-panel">
      {mounted ? <EmbeddedHcdEditor documentId={documentId} token={token}
        apiUrl="/v1/documents" collabUrl="ws://127.0.0.1:8768"
        onClose={() => setMounted(false)} onError={cause => setError(cause.message)} />
        : <p>在上方输入本机服务签发的短期令牌。</p>}
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<Host />)
