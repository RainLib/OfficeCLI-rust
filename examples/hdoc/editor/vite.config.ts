import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { canvasAssets } from './canvasAssets.ts'

const samples = [
  { id: 'accept-image', title: '陶艺时刻.jpg', format: 'JPG', mode: '可编辑图片与局部重绘' },
  { id: 'accept-docx', title: '项目提案', format: 'DOCX', mode: '可编辑' },
  { id: 'accept-pronunciation', title: '中文发音 · 图文课件', format: 'PPTX', mode: '可编辑文字与插图' },
  { id: 'accept-pptx', title: '产品发布演示', format: 'PPTX', mode: '可编辑文字框' },
  { id: 'accept-sushi', title: '霜雪鮨 · 寿司介绍（280 元）', format: 'PPTX', mode: '可编辑文字框' },
  { id: 'accept-xlsx', title: '成绩册', format: 'XLSX', mode: '可编辑单元格' },
  { id: 'accept-usage-xlsx', title: '用量统计（CSV 转 XLSX）', format: 'XLSX', mode: '可编辑单元格' },
  { id: 'accept-md', title: 'Markdown 富文本', format: 'Markdown', mode: '可编辑' },
  { id: 'accept-txt', title: 'TXT 纯文本', format: 'TXT', mode: '可编辑' },
  { id: 'accept-html', title: 'HTML 内容', format: 'HTML', mode: '可编辑' },
  { id: 'accept-agent-table', title: 'Word 表格协作', format: 'DOCX', mode: '可编辑' },
  { id: 'accept-download-txt', title: '下载测试文本', format: 'TXT', mode: '附件下载验收' },
  { id: 'accept-physics-pdf-v2', title: '初三物理练习卷（1 页）', format: 'PDF', mode: '可编辑识别文字' },
  { id: 'demo-pdf-raster-quality', title: 'PDF 版式验证样例', format: 'PDF', mode: '可编辑识别文字' },
  { id: 'accept-case-pdf-v2', title: '审查起诉卷（25 页）', format: 'PDF', mode: '可编辑识别文字' },
  { id: 'accept-evidence-pdf-v2', title: '证据目录及证据（235 页）', format: 'PDF', mode: '可编辑识别文字' },
] as const

function localAcceptanceSamples(): Plugin {
  return {
    name: 'local-hcd-acceptance-samples',
    apply: 'serve',
    configureServer(server) {
      const root = process.env.HCD_DEMO_ROOT
      const secret = process.env.HCD_TOKEN_SECRET
      if (!root || !secret || Buffer.byteLength(secret) < 32) return
      const available = () => samples.filter(sample => existsSync(join(root, `${sample.id}.hcd`, 'manifest.json')))
      server.middlewares.use('/__hcd_demo', (request, response, next) => {
        const path = new URL(request.url || '/', 'http://localhost').pathname
        const send = (status: number, data: unknown) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.setHeader('Cache-Control', 'no-store')
          response.end(JSON.stringify(data))
        }
        if (request.method === 'GET' && path === '/documents') {
          send(200, available())
          return
        }
        const match = /^\/session\/([a-z0-9-]+)$/.exec(path)
        if (request.method !== 'POST' || !match) { next(); return }
        if (request.headers.origin !== `http://${request.headers.host}`) {
          send(403, { error: 'same-origin request required' })
          return
        }
        const sample = available().find(item => item.id === match[1])
        if (!sample) { send(404, { error: 'sample unavailable' }); return }
        const now = Math.floor(Date.now() / 1000)
        const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
        const payload = {
          doc: sample.id,
          scope: sample.mode.startsWith('可编辑') ? 'write' : 'read',
          sub: 'local-acceptance-user',
          name: '验收用户',
          aud: 'hcd-core',
          iat: now,
          exp: now + 3600,
        }
        const signed = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded(payload)}`
        send(200, { documentId: sample.id,
          token: `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}` })
      })
    },
  }
}

const apiTarget = process.env.HCD_API_TARGET || 'http://127.0.0.1:8766'
const apiAgent = new (new URL(apiTarget).protocol === 'https:' ? HttpsAgent : HttpAgent)({
  keepAlive: true, maxSockets: 32, maxFreeSockets: 8,
})

export default defineConfig({
  cacheDir: process.env.HCD_VITE_CACHE_DIR,
  plugins: [canvasAssets(), localAcceptanceSamples(), {
    name: 'hcd-api-proxy-connections',
    configureServer(server) { server.httpServer?.once('close', () => apiAgent.destroy()) },
  }],
  server: {
    port: 8767,
    proxy: {
      '/v1': { target: apiTarget, agent: apiAgent },
      '/health': { target: apiTarget, agent: apiAgent },
    },
  },
})
