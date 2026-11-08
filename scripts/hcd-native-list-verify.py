#!/usr/bin/env python3
"""Check native DOCX lists, Markdown reimport and real files; no model/provider."""
import argparse, hashlib, json, subprocess, tempfile, xml.etree.ElementTree as E, zipfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--bundle',type=Path);parser.add_argument('--revision',type=int,default=10);parser.add_argument('--browser-root',type=Path,help='owned fixture after manual two-person save r2, own undo r3 and redo r4');args=parser.parse_args()
repo=Path(__file__).resolve().parents[1];cli=repo/'target/debug/officecli';root=Path(tempfile.mkdtemp(prefix='hcd-native-lists-'));assets=repo/'docs/assets/hcd-lists-2026-10-24';assets.mkdir(exist_ok=True)
def run(*parts):return subprocess.check_output([str(cli),*map(str,parts)],text=True,timeout=180)
def data(*parts):return json.loads(run(*parts,'--json'))['data']
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';ns={'w':W}
def inspect_docx(path):
 with zipfile.ZipFile(path) as z:
  xml=E.fromstring(z.read('word/document.xml'));numbers=E.fromstring(z.read('word/numbering.xml'));rels=z.read('word/_rels/document.xml.rels').decode();types=z.read('[Content_Types].xml').decode()
  assert 'relationships/numbering' in rels and 'wordprocessingml.numbering+xml' in types
  result=[]
  for p in xml.findall('w:body/w:p',ns):
   text=''.join(n.text or '' for n in p.findall('.//w:t',ns));num=p.find('w:pPr/w:numPr/w:numId',ns);level=p.find('w:pPr/w:numPr/w:ilvl',ns)
   if num is None:result.append({'text':text,'numbered':False});continue
   number=num.attrib['{'+W+'}val'];depth=level.attrib['{'+W+'}val'];instance=numbers.find(f'w:num[@w:numId="{number}"]',ns);assert instance is not None
   abstract=instance.find('w:abstractNumId',ns).attrib['{'+W+'}val'];definition=numbers.find(f'w:abstractNum[@w:abstractNumId="{abstract}"]/w:lvl[@w:ilvl="{depth}"]',ns);assert definition is not None
   override=instance.find(f'w:lvlOverride[@w:ilvl="{depth}"]/w:startOverride',ns);start=override.attrib['{'+W+'}val'] if override is not None else definition.find('w:start',ns).attrib['{'+W+'}val']
   result.append({'text':text,'numbered':True,'numId':number,'depth':int(depth),'format':definition.find('w:numFmt',ns).attrib['{'+W+'}val'],'start':int(start)})
  return result
source=root/'source.md';source.write_text('# 列表兼容验证\n\n4. **父项甲 Parent A**\n\n   7. 子项七 Child seven\n      - 叶项 Leaf\n   8. 子项八 Child eight\n5. 父项乙 Parent B\n\n正文 After\n\n10. 重新编号 Restart\n\n- 项目符号 Bullet\n')
bundle=root/'nested.hcd';data('hdoc','import',source,'--output',bundle,'--document-id','native-lists');data('hdoc','project-editor',bundle,'--expected-revision',0)
files=[]
for fmt in ['docx','md','pdf']:
 path=root/f'nested.{fmt}';data('hdoc','export',bundle,'--revision',1,'--output',path,'--fidelity-report',root/f'{fmt}-fidelity.json');text=path.read_text() if fmt=='md' else run('view',path,'text')
 for label in ['Parent A','Child seven','Leaf','Child eight','Parent B','After','Restart','Bullet']:assert text.count(label)==1,(fmt,label,text)
 files.append({'format':fmt,'sha256':digest(path),'allLabelsExactlyOnce':True})
numbering=inspect_docx(root/'nested.docx');listed=[p for p in numbering if p['numbered']];assert [p['depth'] for p in listed]==[0,1,2,1,0,0,0];assert [p['format'] for p in listed]==['decimal','decimal','bullet','decimal','decimal','decimal','bullet'];assert listed[0]['numId']==listed[4]['numId'];assert listed[1]['numId']==listed[3]['numId'];assert listed[0]['start']==4 and listed[1]['start']==7 and listed[5]['start']==10
# Reimport the actual files, then inspect canonical editor structure, not plain text only.
reimports={}
for fmt in ['docx','md']:
 target=root/f'reopened-{fmt}.hcd';data('hdoc','import',root/f'nested.{fmt}','--output',target,'--document-id','reopened-'+fmt);projection=data('hdoc','editor-state',target)
 (root/f'reopened-{fmt}-state.json').write_text(json.dumps(projection,ensure_ascii=False,indent=2));reimports[fmt]=projection
# Preserve the evidence even when a reader-specific roundtrip limitation is found.
def tree(v):
 c=v.get('content',v);return [c['kind'],c.get('level'),c.get('listStart'),''.join(i['text'] for i in c.get('inlines',[])),[tree(x) for x in c.get('children',[])]]
original=data('hdoc','editor-state',bundle,'--revision',1);original_tree=[tree(b) for b in original['blocks']];md_tree=[tree(b) for b in reimports['md']['blocks']];assert original_tree==md_tree
docx_tree=[tree(b) for b in reimports['docx']['blocks']];assert original_tree==docx_tree,(original_tree,docx_tree)
# Export the reimported Word model again: marker decorations must not enter text.
semantic_exports=[]
for fmt in ['docx','md']:
 path=root/f'docx-reexport.{fmt}';data('hdoc','export',root/'reopened-docx.hcd','--revision',0,'--output',path)
 target=root/f'docx-reexport-{fmt}.hcd';data('hdoc','import',path,'--output',target,'--document-id','reexported-'+fmt)
 state=data('hdoc','editor-state',target);assert [tree(b) for b in state['blocks']]==original_tree,(fmt,state)
 if fmt=='docx':
  repeated=[row for row in inspect_docx(path) if row['numbered']]
  assert [row['depth'] for row in repeated]==[0,1,2,1,0,0,0]
  assert repeated[0]['numId']==repeated[4]['numId'] and repeated[1]['numId']==repeated[3]['numId']
 semantic_exports.append({'format':fmt,'sha256':digest(path),'hierarchyStartsAndTextEqualOriginal':True})
def collect_inlines(content):
 return content.get('inlines',[])+[inline for child in content.get('children',[]) for inline in collect_inlines(child)]
docx_inlines=[inline for b in reimports['docx']['blocks'] for inline in collect_inlines(b['content'])]
entries=data('hdoc','extract-text',root/'reopened-docx.hcd')['entries'];ids=[inline['nodeId'] for inline in docx_inlines]
assert len(ids)==len(set(ids)) and set(ids)=={entry['nodeId'] for entry in entries}
preview=run('view',root/'nested.docx','html');assert '>5.</span>' in preview;assert '>8.</span>' in preview;(root/'native-docx-preview.html').write_text(preview)
report={'boundary':'local real CLI/native packages, reimported canonical models and actual PDF/MD/DOCX; no Office app or production validation','files':files,'nativeNumbering':numbering,'reimports':{'markdown':{'hierarchyStartsAndTextEqualOriginal':True,'formattingMarksNotIncludedInComparison':True,'tree':md_tree},'docx':{'textRetained':all(''.join(i['text'] for i in docx_inlines).count(label)==1 for label in ['Parent A','Child seven','Leaf','Child eight','Parent B','After','Restart','Bullet']),'hierarchyAndHeadingRetained':True,'hierarchyStartsAndTextEqualOriginal':True,'sourceAnchorIdsUniqueAndPreserved':True,'formattingMarksNotIncludedInComparison':True,'tree':docx_tree}},'nativePreviewResumesParentAtFiveAndChildAtEight':True,'docxReexports':semantic_exports,'fixtureRoot':str(root)}
if args.bundle:
 before=hashlib.sha256((args.bundle/'manifest.json').read_bytes()).hexdigest()
 path=root/'collaborative-r10.docx';data('hdoc','export',args.bundle,'--revision',args.revision,'--output',path);rows=inspect_docx(path);expected=['First list item','Second list itemxy','Third list itemqwzrstuv'];found=[next(p for p in rows if p['text'].startswith(label)) for label in expected];assert [p.get('depth') for p in found]==[0,1,1],found
 text=run('view',path,'text');assert text.count('自动补全验证。')==1 and text.count('Bob 补全时输入')==1
 assert hashlib.sha256((args.bundle/'manifest.json').read_bytes()).hexdigest()==before
 report['collaborativeRevision']={'canonicalManifestUnchanged':True,'revision':args.revision,'sha256':digest(path),'nativeDepths':[p['depth'] for p in found],'acceptedAiAndPeerTextRetainedOnce':True}
if args.browser_root:
 browser=args.browser_root.resolve();assert browser.name.startswith('hcd-mention-preview-')
 browser_bundle=browser/'mentions-docx.hcd';source_docx=browser/'sources/mentions-docx.docx'
 before=digest(browser_bundle/'manifest.json');initial=data('hdoc','editor-state',browser_bundle,'--revision',1)
 initial_ids={inline['nodeId'] for block in initial['blocks'] for inline in collect_inlines(block['content']) if inline.get('nodeId')}
 saved=[]
 for revision,accepted in [(2,True),(3,False),(4,True)]:
  record=data('hdoc','get-revision',browser_bundle,revision);assert not record.get('structuralChange',False),record
  projection=data('hdoc','editor-state',browser_bundle,'--revision',revision)
  inlines=[inline for block in projection['blocks'] for inline in collect_inlines(block['content'])]
  text=''.join(inline['text'] for inline in inlines);assert text.count('已验证')==int(accepted) and text.count('Bob 保留')==1
  assert {inline['nodeId'] for inline in inlines if inline.get('nodeId')}==initial_ids
  path=root/f'browser-source-r{revision}.docx';fidelity=root/f'browser-source-r{revision}-fidelity.json'
  data('hdoc','export',browser_bundle,'--source',source_docx,'--revision',revision,'--output',path,'--fidelity-report',fidelity)
  assert json.loads(fidelity.read_text())['level']=='HIGH'
  with zipfile.ZipFile(source_docx) as original_zip,zipfile.ZipFile(path) as exported_zip:
   assert set(original_zip.namelist())==set(exported_zip.namelist())
   assert all(original_zip.read(name)==exported_zip.read(name) for name in original_zip.namelist() if name!='word/document.xml')
   original_xml=E.fromstring(original_zip.read('word/document.xml'));exported_xml=E.fromstring(exported_zip.read('word/document.xml'))
   for document in [original_xml,exported_xml]:
    for text_node in document.findall('.//w:t',ns):text_node.text=''
   assert E.tostring(original_xml)==E.tostring(exported_xml)
  target=root/f'browser-source-r{revision}.hcd';data('hdoc','import',path,'--output',target,'--document-id',f'browser-source-r{revision}')
  reopened=data('hdoc','editor-state',target);assert [tree(block) for block in reopened['blocks']]==[tree(block) for block in projection['blocks']]
  saved.append({'revision':revision,'ownTextAccepted':accepted,'peerTextRetained':True,'sourceNodeIdsRetained':True,'noStructuralRewrite':True,'sourceBackedFidelity':'HIGH','allOtherOoxmlPartsUnchanged':True,'documentStructureAndRunPropertiesUnchanged':True,'reimportedTreeEqualSavedModel':True,'sha256':digest(path)})
 assert before==digest(browser_bundle/'manifest.json')
 report['browserSourceRoundtrip']={'boundary':'manual CUA two-person editing followed by actual native revision, source-backed DOCX and reimport verification','fixtureRoot':str(browser),'canonicalManifestUnchangedByVerification':True,'revisions':saved}
(assets/'native-list-file-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':'PASS native file contents/numbering; reimport model evidence written','root':str(root)},ensure_ascii=False))
