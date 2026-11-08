import * as Y from 'yjs'
import type {Node as PmNode} from '@tiptap/pm/model'
import {digest} from 'lib0/hash/sha256'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import {inlineContainerNodeName} from './semanticInlineContainers.ts'

type Piece={carrier:string;client:number;clock:number;length:number;offset:number}
type ContainerBinding={id:string;offset:number;binding:SourceLeafBinding}
export type SourceLeafBinding={key:string;shape:string;size:number;pieces:Piece[];version?:2;storedSize?:number;containers?:ContainerBinding[]}
/** The source layer also serves the internal composite flow before the full
 * structural/save binding can enable it. Both use the same real carriers. */
export type SourceBindingStore=Pick<SemanticBlockStore,'flow'|'contents'|'content'>
const sourceId=(value:unknown):value is string=>typeof value==='string'&&/^n_[a-f0-9]{32}$/.test(value)
type ShapeToken={text:string}|{mention:string}|{extension:string}|{break:true}|{container:string;content:ShapeToken[]}
function shape(node:PmNode){
 const tokens=(node:PmNode,depth=0):ShapeToken[]=>{
  if(depth>24)throw new Error('Invalid structural source capture')
  const result:ShapeToken[]=[]
  node.forEach(child=>{if(child.isText){const last=result.at(-1);if(last&&'text'in last)last.text+=child.text;else result.push({text:child.text!})}else if(child.type.name==='hcdMention')result.push({mention:child.attrs.reference.mentionId});else if(child.type.name==='hcdExtensionInline')result.push({extension:child.attrs.extension.instanceId});else if(child.type.name==='hardBreak')result.push({break:true});else if(child.type.name===inlineContainerNodeName)result.push({container:child.attrs.extension.instanceId,content:tokens(child,depth+1)});else throw new Error('Invalid structural source capture')})
  return result
 }
 return [...digest(new TextEncoder().encode(JSON.stringify(tokens(node))))].map(byte=>byte.toString(16).padStart(2,'0')).join('')
}
function layout(node:PmNode){
 let size=0;const children:Array<{id:string;offset:number;node:PmNode}>=[]
 node.forEach(child=>{if(child.type.name===inlineContainerNodeName)children.push({id:child.attrs.extension.instanceId,offset:size,node:child});size+=child.isText?child.nodeSize:1})
 return{size,children}
}
function captureRanges(parts:Array<{carrier:string;text:Y.XmlText;from:number;to:number}>){
 const pieces:Piece[]=[];let logical=0
 for(const part of parts){
  let position=0
  for(let item=part.text._start;item;item=item.right){if(item.deleted||!item.countable)continue;const from=Math.max(position,part.from),to=Math.min(position+item.length,part.to);if(to>from)pieces.push({carrier:part.carrier,client:item.id.client,clock:item.id.clock+from-position,length:to-from,offset:logical+from-part.from});position+=item.length}
  logical+=part.to-part.from
 }
 return{logical,pieces}
}
/** Parent pieces use stored offsets; each child captures its OWN permanent
 * body pieces. A wrapper's PM boundary is never a source-bearing character. */
function captureTree(store:SourceBindingStore,key:string,node:PmNode,body=false,seen=new Set<string>()):SourceLeafBinding{
  const structure=layout(node),parts=body?(()=>{const text=store.flow.containers?.bodies.get(key);if(!(text instanceof Y.XmlText))throw new Error('Invalid structural source capture');return[{carrier:key,text,from:0,to:text.length}]})():store.flow.parts(key).map(part=>{const text=store.contents.get(part.carrier)?.get(0);if(!(text instanceof Y.XmlText))throw new Error('Invalid structural source capture');return{...part,text}})
  const {logical,pieces}=captureRanges(parts)
  if(logical!==structure.size)throw new Error('Invalid structural source capture')
  const containers=structure.children.map(child=>{
   if(!store.flow.containers||seen.has(child.id))throw new Error('Invalid structural source capture');seen.add(child.id)
   const actual=store.flow.containers.readBody(child.id)
   if(actual.content.size!==child.node.content.size||shape(actual)!==shape(child.node))throw new Error('Captured source content differs')
   return{id:child.id,offset:child.offset,binding:captureTree(store,child.id,child.node,true,seen)}
  })
  return{key,shape:shape(node),size:node.content.size,pieces,...(containers.length?{version:2,storedSize:logical,containers}:{})}
}
export function captureSourceLeaf(store:SourceBindingStore,key:string,node:PmNode):SourceLeafBinding{
 const result=captureTree(store,key,node);validateSourceLeaf(result,!!store.flow.containers);return result
}
export function validateSourceLeaf(value:unknown,inlineContainers=false):asserts value is SourceLeafBinding{
 if((value as SourceLeafBinding|null)?.version===2&&!inlineContainers)throw new Error('Unsupported inline source capture')
 const integer=(n:unknown,min=0):n is number=>Number.isSafeInteger(n)&&Number(n)>=min,seen=new Set<string>();let pieces=0,containers=0
 const check=(raw:unknown,depth:number,body?:string)=>{
  const v=raw as SourceLeafBinding,tree=v?.version===2
  if(!v||depth>24||Object.keys(v).sort().join(',')!==(tree?'containers,key,pieces,shape,size,storedSize,version':'key,pieces,shape,size')||typeof v.key!=='string'||!v.key.length||v.key.length>128||body!==undefined&&v.key!==body||typeof v.shape!=='string'||!/^[a-f0-9]{64}$/.test(v.shape)||!integer(v.size)||v.size>1_048_576+(tree?2000:0)||!Array.isArray(v.pieces)||(pieces+=v.pieces.length)>100000)throw new Error('Invalid structural source capture')
  let offset=0
  for(const p of v.pieces){if(!p||Object.keys(p).sort().join(',')!=='carrier,client,clock,length,offset'||typeof p.carrier!=='string'||!p.carrier.length||p.carrier.length>128||body!==undefined&&p.carrier!==body||!integer(p.client)||p.client>0xffffffff||!integer(p.clock)||!integer(p.length,1)||!Number.isSafeInteger(p.clock+p.length)||p.offset!==offset)throw new Error('Invalid structural source capture');offset+=p.length}
  if(!tree){if(offset!==v.size)throw new Error('Invalid structural source capture');return}
  if(!integer(v.storedSize)||v.storedSize!==offset||!Array.isArray(v.containers)||!v.containers.length||(containers+=v.containers.length)>1000)throw new Error('Invalid structural source capture')
  let previous=-1,expanded=v.storedSize
  for(const child of v.containers){
   if(!child||Object.keys(child).sort().join(',')!=='binding,id,offset'||typeof child.id!=='string'||!/^x_[a-f0-9]{32}$/.test(child.id)||seen.has(child.id)||!integer(child.offset)||child.offset<=previous||child.offset>=v.storedSize)throw new Error('Invalid structural source capture')
   seen.add(child.id);previous=child.offset;check(child.binding,depth+1,child.id);expanded+=child.binding.size+1
  }
  if(expanded!==v.size)throw new Error('Invalid structural source capture')
 }
 check(value,0)
}
/** A matching whole leaf can be rebound after undo/reload as well. Otherwise
 * only the exact captured item ranges are marked: late insertions and deleted
 * atoms cannot receive a different captured inline's source receipt. */
export function sourceLeafActions(store:SourceBindingStore,key:string,expected:PmNode,captured?:SourceLeafBinding):Array<()=>void>{
 if(captured)validateSourceLeaf(captured,!!store.flow.containers)
 if((captured?.version===2||layout(expected).children.length)&&!store.flow.containers)throw new Error('Unsupported inline source capture')
 const verify=(key:string,node:PmNode,binding:SourceLeafBinding)=>{
  const structure=layout(node)
  if(binding.key!==key||binding.shape!==shape(node)||binding.size!==node.content.size||structure.children.length!==(binding.containers?.length??0)||binding.version===2&&binding.storedSize!==structure.size)throw new Error('Captured source content differs')
  structure.children.forEach((child,index)=>{const stored=binding.containers![index];if(stored.id!==child.id||stored.offset!==child.offset)throw new Error('Captured source content differs');verify(child.id,child.node,stored.binding)})
 }
 if(captured)verify(key,expected,captured)
 const collect=(key:string,expected:PmNode,captured?:SourceLeafBinding,body=false):Array<()=>void>=>{
 const expectedShape=shape(expected),size=expected.content.size,structure=layout(expected)
 let current:PmNode|undefined
 if(body)current=store.flow.containers!.readBody(key)
 else try{current=store.content(key)}catch{/* A joined-away leaf still has its captured permanent carriers. */}
 const exact=current&&(body||current.isTextblock&&store.flow.rootFor(key)===key)&&current.content.size===size&&shape(current)===expectedShape
 // Child bodies can still match after an unrelated parent insertion. Capture
 // those current characters independently, including revived undo items.
 let binding=captured
 if(exact){binding=captureTree(store,key,current!,body);validateSourceLeaf(binding,!!store.flow.containers)}
 if(!binding)return[]
 const ranges:Array<{from:number;to:number;id:string}>=[]
 let storedOffset=0
 expected.forEach(child=>{const length=child.isText?child.nodeSize:1,id=child.marks.find(mark=>mark.type.name==='hcdSource')?.attrs.nodeId;if(child.type.name!==inlineContainerNodeName&&sourceId(id))ranges.push({from:storedOffset,to:storedOffset+length,id});storedOffset+=length})
 type Claim={from:number;to:number;id:string}
 const claims=new Map<string,Map<number,Claim[]>>();let at=0
 for(const piece of binding.pieces){while(at<ranges.length&&ranges[at].to<=piece.offset)at++;for(let index=at;index<ranges.length&&ranges[index].from<piece.offset+piece.length;index++){const range=ranges[index],from=Math.max(piece.offset,range.from),to=Math.min(piece.offset+piece.length,range.to);if(to<=from)continue;const clients=claims.get(piece.carrier)??new Map<number,Claim[]>(),list=clients.get(piece.client)??[];list.push({from:piece.clock+from-piece.offset,to:piece.clock+to-piece.offset,id:range.id});clients.set(piece.client,list);claims.set(piece.carrier,clients)}}
 const actions:Array<()=>void>=body?store.flow.containers!.sourceDefaultActions(key,expected.attrs):[]
 for(const [carrier,clients]of claims){const text=body?store.flow.containers!.bodies.get(carrier):store.contents.get(carrier)?.get(0);if(!(text instanceof Y.XmlText))continue;for(const list of clients.values()){list.sort((a,b)=>a.from-b.from);for(let i=1;i<list.length;i++)if(list[i].from<list[i-1].to)throw new Error('Invalid structural source capture')}
  let position=0,currentSource:unknown
  for(let item=text._start;item;item=item.right){if(item.deleted)continue;if(item.content instanceof Y.ContentFormat){if(item.content.key==='hcdSource')currentSource=item.content.value;continue}if(!item.countable)continue;const list=clients.get(item.id.client)??[];let low=0,high=list.length;while(low<high){const mid=(low+high)>>1;if(list[mid].to<=item.id.clock)low=mid+1;else high=mid}for(let index=low;index<list.length&&list[index].from<item.id.clock+item.length;index++){const claim=list[index],from=Math.max(claim.from,item.id.clock),to=Math.min(claim.to,item.id.clock+item.length),start=position+from-item.id.clock;if(to>from&&(currentSource as {nodeId?:string}|null)?.nodeId!==claim.id)actions.push(()=>text.format(start,to-from,{hcdSource:{nodeId:claim.id}}))}position+=item.length}
 }
 structure.children.forEach((child,index)=>actions.push(...collect(child.id,child.node,binding!.containers?.[index]?.binding,true)))
 return actions
 }
 return collect(key,expected,captured)
}
