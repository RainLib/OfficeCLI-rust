import { useEffect, useRef } from 'react'

/** An explicit opener handshake keeps document credentials out of URLs. */
export function useAdminConnection(ready: boolean, open: (id: string, token: string) => Promise<boolean>) {
  const connect = useRef(open)
  connect.current = open
  useEffect(() => {
    if (!ready) return
    const nonce = new URLSearchParams(location.hash.slice(1)).get('admin-open')
    const parent = window.opener as Window | null
    if (!parent || !nonce || !/^[a-f0-9-]{36}$/.test(nonce)) return
    let receiving = false, active = true
    const receive = (event: MessageEvent) => {
      const value = event.data
      if (receiving || event.source !== parent || !/^https?:\/\//.test(event.origin)
        || value?.type !== 'hcd-admin-open' || value.nonce !== nonce
        || typeof value.documentId !== 'string' || !/^[\w-]{1,128}$/.test(value.documentId)
        || typeof value.token !== 'string' || !value.token || value.token.length > 16_384) return
      receiving = true
      void connect.current(value.documentId, value.token).then(opened => {
        if (!active) return
        parent.postMessage({ type: opened ? 'hcd-editor-opened' : 'hcd-editor-error', nonce }, event.origin)
        history.replaceState(null, '', location.pathname + location.search)
        window.removeEventListener('message', receive)
        window.opener = null
      })
    }
    window.addEventListener('message', receive)
    parent.postMessage({ type: 'hcd-editor-ready', nonce }, '*')
    return () => { active = false; window.removeEventListener('message', receive) }
  }, [ready])
}
