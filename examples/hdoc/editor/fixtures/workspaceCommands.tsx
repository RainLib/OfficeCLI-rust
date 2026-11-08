import {useMemo,useRef,useState} from 'react'
import {EmbeddedHcdEditor,type EmbeddedHcdEditorProps,type EditorCommandService,type CommandExtensions} from '../src/embed.tsx'

/** Local QA harness: exercise the public SDK through visible host controls. */
export function WorkspaceCommandFixture(props:EmbeddedHcdEditorProps){
 const service=useRef<EditorCommandService|null>(null),[choice,setChoice]=useState('host.workspace'),[result,setResult]=useState('等待编辑器')
 const extensions=useMemo<CommandExtensions>(()=>({
  keymap:{'view.collaboration':['Mod+Alt+J']},
  commands:[
   {id:'host.workspace',label:'宿主组合视图',access:'read',ready:false,selectionSensitive:false,surfaces:['palette'],execute:async({commands})=>{await commands.run('view.zoom.set',{percent:100});return commands.run('view.collaboration',{enabled:true})}},
   {id:'host.hideProperties',label:'隐藏属性但保留其他面板',access:'read',ready:false,selectionSensitive:false,surfaces:[],execute:({commands})=>commands.run('view.properties',{enabled:false})},
   {id:'host.unsafeWrite',label:'只读写入边界验证',access:'read',ready:false,surfaces:[],execute:({commands})=>commands.run('text.insert',{text:'HOST-WRITE'})},
  ],
  onReady:commands=>{service.current=commands;setResult('命令已连接');return()=>{if(service.current===commands)service.current=null}},
 }),[])
 const run=async()=>{
  const commands=service.current;if(!commands)return
  try{
   if(choice==='rapid'){await commands.execute('revision.open',{revision:0});await commands.execute('revision.open',{revision:1})}
   else await commands.execute(choice,choice==='revision.open'?{revision:0}:choice==='view.zoom.set'?{percent:125}:undefined)
   setResult(`${choice} 成功`)
  }catch(error){setResult(`${choice} 拒绝 ${error instanceof Error&&'code'in error?String(error.code):'error'}`)}
 }
 return <><div style={{height:'calc(100% - 42px)'}}><EmbeddedHcdEditor {...props} commandExtensions={extensions}/></div><div style={{height:42,display:'flex',gap:8,alignItems:'center',background:'#fff',font:'12px sans-serif',padding:'0 8px'}} aria-label="宿主命令验证"><select aria-label="宿主命令" value={choice} onChange={event=>setChoice(event.target.value)}>{['host.workspace','host.hideProperties','host.unsafeWrite','view.properties','view.collaboration','view.navigation','view.settings','view.zoom.set','view.fit','view.focus','view.readOnly','view.panel.close','revision.history','revision.save','revision.localCopies','revision.open','revision.current','revision.restore.review','rapid'].map(id=><option key={id}>{id}</option>)}</select><button type="button" onClick={()=>void run()}>执行宿主命令</button><output aria-label="宿主命令结果">{result}</output></div></>
}
