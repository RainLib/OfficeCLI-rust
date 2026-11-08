import {useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {useEditorNodeResources} from '../src/useSemanticNodeResources.ts'
import {nodeResourceHash} from '../src/wordNodeResources.ts'
import {structuralProtocol} from '../src/collaborationProtocol.ts'
import type {Session} from '../src/api.ts'
import type {LocalDraftJournal} from '../src/localDrafts.ts'
import type {NodeExtensionRegistry} from '../src/extensionRegistry.ts'
import * as Y from 'yjs'
import {CollaborativeImageDraftStore} from '../src/collaborativeImages.ts'
import {useSemanticImageTasks} from '../src/useSemanticImageTasks.ts'
import type {PositionedImage} from '../src/imageDrafts.ts'

const region='n_'+'1'.repeat(32)
const image:PositionedImage={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt',x:0,y:0,width:30,height:40}}
const node={schemaVersion:'hcd.extension/1' as const,instanceId:'x_'+'2'.repeat(32),type:'test.card',version:1,display:'block' as const,data:{title:'Test'},fallback:{text:'Test'}}
function App(){
 const [documentId,setDocumentId]=useState('scope-a'),[message,setMessage]=useState(''),[pending,setPending]=useState(false)
 const release=useRef<(()=>void)|null>(null),releaseImage=useRef<(()=>void)|null>(null),journal=useMemo(()=>({flush:async()=>{}} as LocalDraftJournal),[])
 const [imageMessage,setImageMessage]=useState(''),[stageCount,setStageCount]=useState(0)
 const session=useMemo<Session>(()=>({documentId,userId:'alice',scope:'write',format:'html',token:'fixture',apiUrl:'/v1/documents',collabUrl:'ws://fixture.invalid',collaborationEpoch:0,collaborationProtocol:structuralProtocol}),[documentId])
 const registry=useMemo(()=>({archiveResource:async (input:{file:Blob;key:string;name:string})=>{
  setMessage(`正在归档 ${documentId}`);await new Promise<void>(resolve=>{release.current=resolve})
  return {key:input.key,name:input.name,mediaType:input.file.type,byteLength:input.file.size,hash:await nodeResourceHash(new Uint8Array(await input.file.arrayBuffer()))}
 }} as Pick<NodeExtensionRegistry,'archiveResource'>),[documentId])
 const tasks=useEditorNodeResources({session,userId:'alice',localJournal:journal,registry,ready:()=>true})
 const document=useMemo(()=>new Y.Doc(),[documentId]),images=useMemo(()=>new CollaborativeImageDraftStore(document),[document])
 const imageTasks=useSemanticImageTasks({session,userId:'alice',localJournal:journal,document,images,ready:()=>true,readyAfterApply:()=>true,synchronize:async()=>true})
 useEffect(()=>{const original=globalThis.fetch;globalThis.fetch=async (input,init)=>{const url=String(input)
  if(url.includes('/images/')){setImageMessage(`正在核验 ${url.includes('scope-a')?'scope-a':'scope-b'}`);await new Promise<void>(resolve=>{releaseImage.current=resolve});return Response.json({image})}
  if(url.includes('/staged-assets')){setStageCount(value=>value+1);return Response.json({hash:'0'.repeat(64)})}
  return original(input,init)
 };return()=>{globalThis.fetch=original}},[])
 const jobs=tasks.client?.state().jobs??[]
 return <main><h1>文档任务隔离验证</h1><p>当前文档：{documentId}</p><button onClick={()=>{setDocumentId(documentId==='scope-a'?'scope-b':'scope-a');setPending(false);setMessage('');setImageMessage('')}}>切换文档</button>{' '}
  <button disabled={!tasks.client} onClick={()=>{const client=tasks.client;if(client)void client.start(new File(['fixture attachment'],'scope.txt',{type:'text/plain'}),node,region).catch(()=>setMessage('旧任务已停止'))}}>选择附件</button>{' '}
  <button onClick={()=>{release.current?.();release.current=null}}>完成模拟响应</button>{' '}
  <button disabled={!tasks.client} onClick={()=>void tasks.client?.checkPending().then(setPending)}>核对任务</button>{' '}
  <button disabled={!tasks.client||!jobs.length} onClick={()=>{const client=tasks.client,id=jobs[0]?.id;if(client&&id)void client.readPendingFile(id).then(async value=>setMessage(`附件内容：${await value.blob.text()}`))}}>校验附件</button>
  <p role="status">{message}</p><p>任务数量：{jobs.length} · {pending?'有待处理任务':'未核对或无任务'}</p><ul>{jobs.map(job=><li key={job.id}>{job.name} · {job.phase}</li>)}</ul>
  <h2>图片任务</h2><button disabled={imageTasks.isBusy()} onClick={()=>void imageTasks.choose(new File(['fixture image'],'scope.png',{type:'image/png'}),image,0).catch(()=>setImageMessage('旧图片任务已停止'))}>选择图片</button>{' '}
  <button onClick={()=>{releaseImage.current?.();releaseImage.current=null}}>完成图片核验</button>{' '}
  <button disabled={!imageTasks.choices.length} onClick={()=>setImageMessage(`图片内容：${new TextDecoder().decode(imageTasks.choices[0].bytes)}`)}>校验图片</button>
  <p>{imageMessage}</p><p>图片任务数量：{imageTasks.choices.length} · 暂存请求：{stageCount}</p><ul>{imageTasks.choices.map(choice=><li key={choice.id}>{choice.name} · {choice.phase}</li>)}</ul>
 </main>
}
createRoot(document.getElementById('root')!).render(<App/>)
