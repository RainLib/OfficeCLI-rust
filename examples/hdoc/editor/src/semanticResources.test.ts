import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSemanticResources } from './semanticResources.ts'
import type { Session } from './api.ts'

test('semantic consumers share immutable reads, refresh the head, and isolate renewed credentials', async () => {
  const original = globalThis.fetch, requests: Array<{ route: string; token: string | null }> = []
  let revision = 1, token = 'first'
  const session: Session = { documentId:'document', apiUrl:'http://local/v1/documents', token:'unused', accessToken:()=>token, scope:'write', format:'docx' }
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)), headers = new Headers(options?.headers)
    requests.push({route:url.pathname.split('/').at(-1)!+url.search,token:headers.get('Authorization')})
    if (url.pathname.endsWith('/theme')) return new Response(null,{status:404})
    if (url.pathname.endsWith('/styles')) return new Response('p{color:black}')
    return Response.json({documentId:'document',revision:Number(url.searchParams.get('revision') || revision),blocks:[]})
  }
  try {
    const resources = createSemanticResources(()=>session)
    await Promise.all([resources.load(1),resources.load(1),resources.projection(1)])
    assert.equal(requests.filter(request=>request.route==='editor?revision=1').length,1)
    assert.equal(requests.filter(request=>request.route==='styles?revision=1').length,1)
    assert.equal((await resources.projection()).revision,1)
    revision = 2
    assert.equal((await resources.projection()).revision,2)
    const before = requests.length
    await resources.projection(2)
    assert.equal(requests.length,before)
    token = 'renewed'
    await resources.projection(2)
    assert.equal(requests.at(-1)?.token,'Bearer renewed')
    assert.equal(requests.length,before+1)
    for (const revision of [3,4,5,6]) await resources.projection(revision)
    const retained = requests.length
    await resources.projection(2)
    assert.equal(requests.length,retained+1,'old revisions are evicted rather than retained indefinitely')
  } finally { globalThis.fetch = original }
})

test('a failed revision read can be retried without poisoning the mounted document', async () => {
  const original = globalThis.fetch
  let failed = true
  globalThis.fetch = async () => {
    if (failed) return new Response('temporary failure',{status:503})
    return Response.json({documentId:'document',revision:4,blocks:[]})
  }
  try {
    const resources = createSemanticResources(()=>({documentId:'document',apiUrl:'http://local/v1/documents',token:'test',scope:'write',format:'docx'}))
    await assert.rejects(resources.projection(4),/503/)
    failed = false
    assert.equal((await resources.projection(4)).revision,4)
  } finally { globalThis.fetch = original }
})
