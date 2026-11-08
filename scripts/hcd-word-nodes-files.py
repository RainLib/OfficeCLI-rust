#!/usr/bin/env python3
"""Read real regional node browser/socket versions and DOCX/HCDZ resources."""
import argparse,hashlib,json,os,posixpath,re,shutil,subprocess,tempfile,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def main():
 parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);parser.add_argument('--browser-docx',type=Path);parser.add_argument('--browser-hcdz',type=Path);args=parser.parse_args()
 repo=Path(__file__).resolve().parents[1];root=args.fixture.resolve()
 if root.parent!=repo/'target/hcd-preview-runtime' or not root.name.startswith('word-room-'):raise ValueError('isolated fixture required')
 config=json.loads((root/'private.json').read_text());assert config.get('nodesFixture');socket=json.loads((root/'nodes-socket-evidence.json').read_text())
 bundle=root/'rich.hcd';head=json.loads((bundle/'manifest.json').read_text())['revision'];assert head>=10
 binary=repo/'target/debug/officecli';env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':config['secret']};work=Path(tempfile.mkdtemp(prefix='nodes-files-',dir=root));assets=repo/'docs/assets/hcd-word-nodes-regional-2026-10-27';assets.mkdir(exist_ok=True)
 def cli(*args):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=work,env=env,capture_output=True,text=True,check=True);return json.loads(result.stdout)['data']
 states={n:cli('editor-state',bundle,'--revision',n) for n in range(head+1)}
 def nodes(state):
  result=[]
  def walk(content,region):
   if content.get('extension'):result.append((region,content['extension'],content))
   for inline in content.get('inlines',[]):
    if inline.get('extension'):result.append((region,inline['extension'],inline))
    if inline.get('content'):walk(inline['content'],region)
   for child in content.get('children',[]):walk(child,region)
  for block in state['blocks']:walk(block['content'],block.get('region'))
  return result
 def find(revision,kind,region='body'):return next(value for area,value,_ in nodes(states[revision]) if area==region and value['type']==kind)
 assert find(2,'example.status')['data']=={'label':'已确认','owner':'Alice 王'}
 card=find(3,'example.card');resource=card['resources'][0];assert resource['hash']==hashlib.sha256((root/'replacement.png').read_bytes()).hexdigest();assert resource['name']=='replacement.png'
 rich=next(content for area,value,content in nodes(states[4]) if value['type']=='example.note');assert rich['extension']['contentModel']=='blocks' and len(rich['children'])==2
 assert '说明块正文 😀' in json.dumps(rich,ensure_ascii=False) and '第二个段落' in json.dumps(rich,ensure_ascii=False)
 # The writer without codecs changes ordinary body text, preserving all values.
 assert {value['instanceId']:value for _,value,_ in nodes(states[4])}=={value['instanceId']:value for _,value,_ in nodes(states[5])}
 assert '无扩展端正文' in json.dumps(states[5],ensure_ascii=False)
 merged,undone,redone=socket['fieldMergeRevision'],socket['ownUndoRevision'],socket['ownRedoRevision']
 assert find(merged,'example.status')['data']=={'label':'协同标签','owner':'Bob 李'}
 assert find(undone,'example.status')['data']=={'label':'已确认','owner':'Bob 李'}
 assert find(redone,'example.status')['data']=={'label':'协同标签','owner':'Bob 李'}
 assert find(head,'example.status')['data']=={'label':'候选 B','owner':'Bob 李'}
 assert find(head,'example.status','header')['data']=={'label':'页眉标记','owner':'文档组'}
 assert find(head,'example.card')['resources']==card['resources']
 docx=work/f'nodes-r{head}.docx';cli('export',bundle,'--revision',head,'--output',docx)
 with zipfile.ZipFile(docx) as z:
  document=ET.fromstring(z.read('word/document.xml'));text=''.join(document.itertext())
  for expected in ['候选 B · Bob 李','区域资料 · 团队','说明块正文 😀','第二个段落','无扩展端正文']:assert text.count(expected)==1,(expected,text)
  assert '页眉标记' not in text
  headers=[]
  for name in z.namelist():
   if name.startswith('word/') and name.endswith('.xml'):
    part=ET.fromstring(z.read(name))
    if part.tag.endswith('}hdr'):headers.append(''.join(part.itertext()))
  assert sum(value.count('页眉标记 · 文档组') for value in headers)==1
  rels={node.attrib['Id']:node.attrib['Target'] for node in ET.fromstring(z.read('word/_rels/document.xml.rels'))}
  embedded=[]
  for node in document.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):
   target=rels[node.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed']];embedded.append(hashlib.sha256(z.read(posixpath.normpath('word/'+target))).hexdigest())
  assert resource['hash'] in embedded
  with zipfile.ZipFile(root/'source.docx') as original:
   media=lambda archive:{hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist() if name.startswith('word/media/')}
   assert media(original)<=media(z)
 archive=work/'nodes-history.hcdz';offline=work/'offline.hcd';cli('pack',bundle,'--output',archive);cli('unpack',archive,'--output',offline)
 for n,state in states.items():assert cli('editor-state',offline,'--revision',n)==state
 assert resource['hash'] in {hashlib.sha256(path.read_bytes()).hexdigest() for path in (offline/'assets').rglob('*') if path.is_file()}
 assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
 result={'scope':'Local synthetic browser and real Socket/native/files/offline evidence only. No old-room migration, remote-store or production claim.','fixture':str(root),'head':head,'socket':socket,'resource':resource,'missingCodecWriterPreservedExactPayloads':True,'docxBodyAndHeaderPlacement':True,'docxEmbeddedResourceBytes':True,'sourceMediaRetained':True,'richChildrenPreserved':True,'offlineAllVersionsExact':list(states),'nativeAndOfflineValidate':True,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
 if args.browser_docx:
  def parts(z):return {name:re.sub(rb' w:paraId="[a-f0-9]{8}"',b'',z.read(name)) if name.endswith('.xml') else z.read(name) for name in z.namelist()}
  with zipfile.ZipFile(args.browser_docx) as a,zipfile.ZipFile(docx) as b:assert parts(a)==parts(b)
  shutil.copy2(args.browser_docx,assets/f'browser-nodes-r{head}.docx');result['browserDocxEqualsNativeExceptGeneratedParagraphIds']=True
 if args.browser_hcdz:
  downloaded=work/'browser-offline.hcd';cli('unpack',args.browser_hcdz.resolve(),'--output',downloaded)
  for n,state in states.items():assert cli('editor-state',downloaded,'--revision',n)==state
  assert cli('validate',downloaded)['valid'];shutil.copy2(args.browser_hcdz,assets/f'browser-nodes-r{head}.hcdz');result['browserArchiveAllVersionsExact']=True
 for file in [docx,archive,root/'nodes-socket-evidence.json']:shutil.copy2(file,assets/file.name)
 (assets/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
