import {useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n.tsx'
import {NodeExtensionsProvider,useNodeExtensions} from '../src/NodeExtensions.tsx'
import {useEditorNodeResources} from '../src/useSemanticNodeResources.ts'
import {structuralProtocol} from '../src/collaborationProtocol.ts'
import {nodeResourceHash} from '../src/wordNodeResources.ts'
import type {Session} from '../src/api.ts'
import type {LocalDraftJournal} from '../src/localDrafts.ts'

const node={schemaVersion:'hcd.extension/1' as const,instanceId:'x_'+'2'.repeat(32),type:'test.card',version:1,display:'block' as const,data:{},fallback:{text:'Test'}}
function Tasks({session}:{session:Session}){
 const registry=useNodeExtensions(),first=useRef(registry),journal=useMemo(()=>({flush:async()=>{}} as LocalDraftJournal),[])
 const tasks=useEditorNodeResources({session,userId:'alice',registry,localJournal:journal,ready:()=>true}),[message,setMessage]=useState('')
 const jobs=tasks.client?.state().jobs??[]
 return <section><p>注册器：{first.current===registry?'保持':'已更换'}</p><button disabled={!tasks.client} onClick={()=>void tasks.client?.start(new File(['token fixture'],'test.txt',{type:'text/plain'}),node,'body').then(()=>setMessage('归档完成')).catch(()=>setMessage('归档中断'))}>归档附件</button><p>{message}</p><p>附件任务：{jobs.length}</p><ul>{jobs.map(job=><li key={job.id}>{job.phase}</li>)}</ul></section>
}
function App(){
 const [token,setToken]=useState('old'),[doc,setDoc]=useState('token-a'),[requests,setRequests]=useState<string[]>([]),[held,setHeld]=useState(false),release=useRef<(()=>void)|null>(null)
 const session=useMemo<Session>(()=>({documentId:doc,userId:'alice',scope:'write',format:'html',token,apiUrl:'/v1/documents',collabUrl:'ws://fixture.invalid',collaborationEpoch:0,collaborationProtocol:structuralProtocol}),[doc,token])
 useEffect(()=>{const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{if(String(input).includes('/resources?')){const bytes=new Uint8Array(await (init?.body as Blob).arrayBuffer()),auth=(init?.headers as Record<string,string>).Authorization;setRequests(previous=>[...previous,auth]);if(auth==='Bearer old'){setHeld(true);await new Promise<void>(resolve=>{release.current=resolve})}return Response.json({hash:await nodeResourceHash(bytes),byteLength:bytes.length})}return original(input,init)};return()=>{globalThis.fetch=original}},[])
 return <main><h1>令牌刷新与附件归档</h1><p>文档：{doc} · 凭证：{token}</p><button onClick={()=>setToken('new')}>刷新令牌</button><button onClick={()=>{release.current?.();release.current=null;setHeld(false)}}>完成旧请求</button><button onClick={()=>setDoc('token-b')}>切换文档</button><p>旧请求：{held?'等待中':'未等待'} · 请求凭证：{requests.join(', ')||'无'}</p><NodeExtensionsProvider session={session}><Tasks session={session}/></NodeExtensionsProvider></main>
}
createRoot(document.getElementById('root')!).render(<I18nProvider initialLocale="zh-CN"><App/></I18nProvider>)
