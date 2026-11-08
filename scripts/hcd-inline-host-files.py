#!/usr/bin/env python3
"""Consume the actual packed inline SDK, then verify owned native/offline files.
No room, user preview, network write, or source archive mutation.
"""
import hashlib,json,shutil,subprocess,tarfile,tempfile,zipfile,argparse,re
import xml.etree.ElementTree as ET
from pathlib import Path


def main():
 parser=argparse.ArgumentParser();parser.add_argument('--clipboard',action='store_true');args=parser.parse_args()
 repo=Path(__file__).resolve().parents[1]; editor=repo/'examples/hdoc/editor'; binary=repo/'target/debug/officecli'
 root=Path(tempfile.mkdtemp(prefix='hcd-inline-host-files-',dir=repo/'target/hcd-preview-runtime'))
 evidence=repo/('docs/assets/hcd-inline-clipboard-2026-10-27' if args.clipboard else 'docs/assets/hcd-inline-host-2026-10-27'); evidence.mkdir(exist_ok=True)
 archive=repo/'docs/assets/hcd-inline-content-native-2026-10-26/inline-native-r8.hcdz'
 sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 original=sha(archive)
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json'],text=True))['data']
 packed=json.loads(subprocess.check_output(['npm','pack','--ignore-scripts','--pack-destination',str(root),'--json'],cwd=editor,text=True))[0]
 target=root/'node_modules';target.mkdir()
 for item in (editor/'node_modules').iterdir():
  if item.name!='@officecli':(target/item.name).symlink_to(item,target_is_directory=item.is_dir())
 install=target/'@officecli';install.mkdir()
 with tarfile.open(root/packed['filename']) as package:package.extractall(root/'unpacked',filter='data')
 shutil.move(str(root/'unpacked/package'),install/'hcd-reference-editor')
 package_files={value['path'] for value in packed['files']}
 assert 'src/inline-containers.d.ts' in package_files and 'dist-embed/inline-containers.js' in package_files
 bundle=root/'sdk.hcd';cli('unpack',archive,'--output',bundle)
 before=cli('editor-state',bundle);assert before['revision']==8
 (root/'before.json').write_text(json.dumps(before,ensure_ascii=False))
 consumer=root/'consumer.mts'
 consumer.write_text('''import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {Node,Mark,getSchema} from '@tiptap/core'
import {Slice,Fragment} from '@tiptap/pm/model'
import {InlineContainerRegistry,SemanticInlineContainerNode,readInlineContainerPayload,prepareInlineContainerHistoryGuard,copyInlineContainerSlice,type InlineContainerDefinition} from '@officecli/hcd-reference-editor/inline-containers'
import type {NodeExtensionDefinition} from '@officecli/hcd-reference-editor/react'
const formats=['docx','pdf','pptx','md'] as const
const definition:InlineContainerDefinition={type:'example.sdk_field',version:1,display:'inline',contentModel:'inline',label:'SDK 字段',defaultData:{title:'SDK 标签'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title),exportAdapters:Object.fromEntries(formats.map(format=>[format,({data}:{data:Readonly<Record<string,unknown>>})=>({support:'semantic',includeContent:true,blocks:[{kind:'paragraph',runs:[{text:'SDK: '}]}]})]))}
// @ts-expect-error an opt-in inline definition cannot enter the legacy host contract
const legacy:NodeExtensionDefinition=definition
const registry=new InlineContainerRegistry([definition]),schema=getSchema([Node.create({name:'doc',topNode:true,content:'paragraph+'}),Node.create({name:'paragraph',group:'block',content:'inline*'}),Node.create({name:'text',group:'inline'}),Node.create({name:'hcdMention',inline:true,group:'inline',atom:true,addAttributes(){return{reference:{default:null}}}}),Mark.create({name:'bold'}),Mark.create({name:'hcdSource',addAttributes(){return{nodeId:{default:null}}}}),SemanticInlineContainerNode.configure({registry:()=>registry})])
assert.equal(registry.capabilities().requiresNegotiatedModel,true)
const value=registry.create('example.sdk_field');assert.ok(registry.resolve(value));assert.deepEqual(readInlineContainerPayload(value),value)
const body=schema.nodes.hcdExtensionInlineContainer.createChecked({extension:value},schema.text('SDK 正文😀')),document=schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,body))
assert.equal(prepareInlineContainerHistoryGuard(document,registry.resolve),undefined);assert.equal(document.textContent,'SDK 正文😀')
const [input,output,mode]=process.argv.slice(2),projection=JSON.parse(await readFile(input,'utf8')),block=projection.blocks[0]
const resource=block.content.inlines.find((part:any)=>part.content?.extension?.resources?.length)?.content.extension.resources[0];assert.ok(resource)
let extension=registry.create('example.sdk_field',undefined,[resource]),inlines:any[]=[{text:'SDK 正文😀',bold:true}],clipboard:any=null
if(mode==='clipboard'){
 const reference={type:'hcd.mention',version:1,mentionId:'m_'+'f'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice 王'}},node=schema.nodes.hcdExtensionInlineContainer.createChecked({extension,hcdSourceId:'n_'+'a'.repeat(32)},[schema.text('SDK 正文😀',[schema.marks.bold.create(),schema.marks.hcdSource.create({nodeId:'n_'+'b'.repeat(32)})]),schema.nodes.hcdMention.createChecked({reference})]),copy=copyInlineContainerSlice(new Slice(Fragment.from(node),0,0)).content.firstChild!
 assert.notEqual(copy.attrs.extension.instanceId,extension.instanceId);assert.notEqual(copy.lastChild!.attrs.reference.mentionId,reference.mentionId);assert.equal(copy.attrs.hcdSourceId,null);assert.equal(copy.firstChild!.marks.some(mark=>mark.type.name==='hcdSource'),false)
 clipboard={originalInstanceId:extension.instanceId,originalMentionId:reference.mentionId,copiedMentionId:copy.lastChild!.attrs.reference.mentionId,newBodyIdentity:true,sourceIdsCleared:true,hostProseMirrorFragmentAccepted:true};extension=copy.attrs.extension;inlines=[{text:copy.firstChild!.text,bold:true},{text:'@Alice 王',reference:copy.lastChild!.attrs.reference}]
}
block.content.inlines.push({text:'',content:{kind:'extension',extension,inlines}})
await writeFile(output,JSON.stringify({schemaVersion:'hcd-patch/4',documentId:projection.documentId,patchId:'owned-inline-host-sdk',baseRevision:projection.revision,actor:{name:'Owned host SDK file verification'},operations:[{op:'block.replace',blockId:block.blockId,block:block.content,precondition:{blockHash:block.blockHash}}]}))
await writeFile(output+'.payload.json',JSON.stringify({extension,resource,clipboard},null,2))
console.log('PASS packed SDK runtime and host-created envelope/body/resource patch')
''')
 subprocess.run([str(editor/'node_modules/.bin/tsc'),'--outDir',str(root/'compiled'),'--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck',str(consumer)],cwd=root,check=True)
 patch=root/'patch.json';subprocess.run(['node',str(root/'compiled/consumer.mjs'),str(root/'before.json'),str(patch),'clipboard' if args.clipboard else 'host'],cwd=root,check=True)
 sdk=json.loads((root/'patch.json.payload.json').read_text())
 cli('apply',bundle,'--patch',patch,'--expected-revision',8);after=cli('editor-state',bundle);assert after['revision']==9 and cli('validate',bundle)['valid']
 added=after['blocks'][0]['content']['inlines'][-1]['content'];assert added['extension']==sdk['extension'] and added['inlines'][0]['text']=='SDK 正文😀'
 if args.clipboard:
  def identities(content):
   result={'sources':set(),'mentions':set()}
   for part in content.get('inlines',[]):
    if part.get('nodeId'):result['sources'].add(part['nodeId'])
    if part.get('reference'):result['mentions'].add(part['reference']['mentionId'])
    if part.get('content'):
     nested=identities(part['content'])
     for key in result:result[key].update(nested[key])
   for child in content.get('children',[]):
    nested=identities(child)
    for key in result:result[key].update(nested[key])
   return result
  old={'sources':set(),'mentions':set()}
  for block in before['blocks']:
   current=identities(block['content'])
   for key in old:old[key].update(current[key])
  node_id=added['inlines'][0]['nodeId'];mention_id=added['inlines'][1]['reference']['mentionId']
  assert re.fullmatch('n_[a-f0-9]{32}',node_id) and node_id not in old['sources']
  assert mention_id==sdk['clipboard']['copiedMentionId'] and mention_id not in old['mentions']
  sdk['clipboard'].update(nativeSourceReassigned=True,nativeMentionIdRetained=True)
 packed_doc=root/'sdk-r9.hcdz';cli('pack',bundle,'--output',packed_doc)
 offline=root/'offline.hcd';cli('unpack',packed_doc,'--output',offline);assert cli('editor-state',offline)==after and cli('editor-state',offline,'--revision',8)==before
 asset=root/'resource.png';cli('get-asset',offline,sdk['resource']['hash'],'--output',asset);assert sha(asset)==sdk['resource']['hash'] and asset.stat().st_size==sdk['resource']['byteLength']
 files=[]
 for fmt in ['docx','pdf','pptx','md']:
  output=root/f'sdk-r9.{fmt}';cli('export',offline,'--to',fmt,'--output',output)
  if fmt=='md':
   imported=root/'markdown.hcd';cli('import',output,'--output',imported,'--document-id','owned-inline-host-md');text=''.join(value['text'] for value in cli('extract-text',imported)['entries'])
  else:text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  assert text.count('SDK 正文😀')==1 and text.count('SDK: ')==1 and 'SDK 标签' not in text,(fmt,text)
  if args.clipboard:assert text.count('@Alice 王')==5,(fmt,text)
  files.append({'format':fmt,'sha256':sha(output),'bytes':output.stat().st_size,'liveBodyAndAdapterExactlyOnce':True})
 with zipfile.ZipFile(root/'sdk-r9.docx') as z:
  ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'};tree=ET.fromstring(z.read('word/document.xml'));runs=[run for run in tree.findall('.//w:r',ns) if 'SDK 正文😀' in ''.join(run.itertext())];assert len(runs)==1 and runs[0].find('w:rPr/w:b',ns) is not None
 assert sha(archive)==original
 for name in ['before.json','patch.json','patch.json.payload.json','sdk-r9.hcdz','sdk-r9.docx','sdk-r9.pdf','sdk-r9.pptx','sdk-r9.md']:shutil.copyfile(root/name,evidence/name)
 (evidence/'file-evidence.json').write_text(json.dumps({'scope':'Actual local packed package consumer, strict TypeScript, native CLI and source-free HCDZ/files. No Socket/active-room/native browser-save or desktop Office visual acceptance.','packageSha256':sha(root/packed['filename']),'packedTypeAndRuntimeEntries':True,'legacyHostTypeRejected':True,'standaloneSchemaCreated':True,'clipboard':sdk['clipboard'],'originalArchiveUnchanged':True,'inputArchiveSha256':original,'nativeBinarySha256':sha(binary),'inputRevision':8,'savedRevision':9,'offlineHistoryAndProjectionExact':True,'resourceBytesExact':True,'docxBoldXmlVerified':True,'exports':files,'runtime':str(root)},ensure_ascii=False,indent=2)+'\n')
 print('PASS actual packed SDK/type consumer, native r8→r9, four exports and offline HCDZ/resource history')


if __name__=='__main__':main()
