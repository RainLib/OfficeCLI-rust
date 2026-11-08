import {useState} from 'react'
import {I18nProvider} from '../src/i18n.tsx'
import {DocumentProblemView,DocumentLoading,DocumentErrorBoundary} from '../src/DocumentProblem.tsx'
import {documentProblem,documentProblemCodes,type DocumentProblemCode} from '../src/documentProblems.ts'
import '../src/style.css'

function RenderFailureFixture(){const[failed,setFailed]=useState(false);if(failed)throw new Error('PRIVATE_RENDER_DETAIL');return <div style={{padding:24}}><p>渲染异常演练：点击后会显示恢复页，重新尝试后回到这里。</p><button onClick={()=>setFailed(true)}>触发显示异常</button></div>}

/** Isolated visual QA only. No document, credential, or draft mutation. */
export function DocumentProblemFixture(){
 const [code,setCode]=useState<DocumentProblemCode>('HCD-DOC-1003'),[compact,setCompact]=useState(false),[loading,setLoading]=useState(false),[simulate,setSimulate]=useState(false),[result,setResult]=useState('这是异常状态设计预览，不会修改文档。')
 return <I18nProvider initialLocale="zh-CN"><div className="hcd-surface" style={{height:'100vh'}}>
  <nav aria-label="异常页设计预览" style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:12,padding:'10px 20px',fontSize:12,background:'#edf1f8'}}>
   <strong>异常页设计预览</strong><select aria-label="错误类型" value={code} onChange={event=>{setLoading(false);setCode(event.target.value as DocumentProblemCode)}}>{documentProblemCodes.map(value=><option key={value}>{value}</option>)}</select>
   <label><input type="checkbox" checked={compact} onChange={event=>setCompact(event.target.checked)}/>页内提示</label><button onClick={()=>setLoading(value=>!value)}>切换加载状态</button><label><input type="checkbox" checked={simulate} onChange={event=>setSimulate(event.target.checked)}/>渲染异常演练</label><span role="status">{result}</span>
  </nav>
  <div style={{height:'calc(100% - 54px)',padding:compact?24:0,boxSizing:'border-box'}}>{simulate?<DocumentErrorBoundary documentId="演练文档"><RenderFailureFixture/></DocumentErrorBoundary>:loading?<DocumentLoading documentId="产品方案.docx"/>:<DocumentProblemView problem={documentProblem(code,code.startsWith('HCD-DOC-4')?'recovery':code==='HCD-DOC-9000'?'render':'open',code==='HCD-DOC-1003'?403:undefined)} documentId="产品方案.docx" compact={compact} onRetry={()=>setResult('已触发重试（设计预览）')} onClose={()=>setResult('已触发返回原应用（设计预览）')}/>}</div>
 </div></I18nProvider>
}
