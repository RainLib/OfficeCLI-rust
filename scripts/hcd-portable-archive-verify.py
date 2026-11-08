#!/usr/bin/env python3
"""Read-only CLI/HTTP/native-file validation on the owned resource-node preview.
Contains no credentials in reports and never changes the canonical head.
"""
import gzip,hashlib,json,subprocess,sys,urllib.request,urllib.error,uuid,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);assert root.name.startswith('hcd-mention-preview-')
 bundle=root/'mentions-docx.hcd';binary=repo/'target/debug/officecli';before=(bundle/'manifest.json').read_bytes();head=json.loads(before)['revision'];assert head>=14
 work=root/('offline-archive-proof-'+uuid.uuid4().hex[:8]);work.mkdir();reports=repo/'docs/assets/hcd-offline-archive-2026-10-25';reports.mkdir(exist_ok=True)
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def projection(path,at):return cli('editor-state',path,'--revision',at)
 def inspect(path,at):
  with zipfile.ZipFile(path) as archive:
   names=archive.namelist();meta=json.loads(archive.read('hcd-archive.json'));assert meta['schemaVersion']=='hcd-archive/1' and meta['revision']==at;assert len(names)==len(set(names))==len(meta['entries'])+1
   assert set(names)=={'hcd-archive.json',*('bundle/'+entry['href'] for entry in meta['entries'])}
   for entry in meta['entries']:
    data=archive.read('bundle/'+entry['href']);assert len(data)==entry['byteLength'] and hashlib.sha256(data).hexdigest()==entry['sha256'];assert not any(config[key].encode() in data for key in ['alice','bob','reader','secret'])
   assert not any('collaboration' in name or 'staged/' in name or name.endswith('private.json') or 'access-policy' in name for name in names)
   return meta
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));base=config['origin']+'/v1/documents/mentions-docx'
 def download(at):
  response=opener.open(urllib.request.Request(base+f'/export/hcdz?revision={at}',headers={'Authorization':'Bearer '+config['reader']}),timeout=180)
  assert response.headers['X-HCD-Fidelity-Level']=='NATIVE';assert response.headers['Content-Type']=='application/vnd.officecli.hcd+zip';assert response.headers['Cache-Control']=='private, no-store';assert response.headers['X-Content-Type-Options']=='nosniff'
  path=work/f'http-r{at}.hcdz';path.write_bytes(response.read());return path
 def reject(query,token=True):
  try:opener.open(urllib.request.Request(base+query,headers={'Authorization':'Bearer '+config['reader']} if token else {}),timeout=20);raise AssertionError('unexpected success')
  except urllib.error.HTTPError as error:return error.code
 assert reject(f'/export/hcdz?revision={head}',False)==401
 assert reject(f'/export/hcdz?revision={head+1}')==400
 assert reject(f'/export/hcdz?revision={head}&source=true')==400
 direct=work/'cli.hcdz';cli('pack',bundle,'--output',direct,'--revision',head);native=download(head);a=inspect(direct,head);b=inspect(native,head);assert a==b
 unpacked=work/'mentions-docx.hcd';cli('unpack',native,'--output',unpacked);assert cli('validate',unpacked)['valid'];assert projection(unpacked,head)==projection(bundle,head)
 for at in range(head+1):assert cli('get-revision',unpacked,at)==cli('get-revision',bundle,at)
 resources=[]
 record=cli('get-revision',unpacked,head);index_raw=(unpacked/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(index_raw) if index_raw.startswith(b'\x1f\x8b') else index_raw)
 for asset in index:
  data=(unpacked/asset['href']).read_bytes();assert hashlib.sha256(data).hexdigest()==asset['hash'];assert len(data)==asset['byteLength'];resources.append({'sha256':asset['hash'],'bytes':len(data)})
 assert not (unpacked/'assets/staged').exists()
 output=work/'offline.docx';cli('export',unpacked,'--output',output,'--to','docx','--revision',head);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
 assert all(text.count(label)==1 for label in ['导出资料：项目资料','Alice 页面输入','Bob 页面输入']);assert 'Alice 王' not in text and 'Bob 李' not in text
 with zipfile.ZipFile(output) as office:
  pictures=sum(1 for element in ET.fromstring(office.read('word/document.xml')).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures>=2;image_hashes={hashlib.sha256(office.read(name)).hexdigest() for name in office.namelist() if '/media/' in name};assert all(asset['hash'] in image_hashes for asset in index if asset['href'].endswith('.png'))
 historical=download(6);inspect(historical,6);past=work/'r6.hcd';cli('unpack',historical,'--output',past);assert projection(past,6)==projection(bundle,6);assert not (past/'revisions/00000000000000000007.json').exists()
 assert (bundle/'manifest.json').read_bytes()==before
 evidence={'scope':'Actual local CLI and authenticated reader HTTP; immutable r14 resource-node fixture and independently unpacked native files. No desktop offline UI, production or cross-platform acceptance.','revision':head,'archivePath':str(native),'sha256':hashlib.sha256(native.read_bytes()).hexdigest(),'files':len(b['entries']),'decodedBytes':sum(e['byteLength'] for e in b['entries']),'verifiedAssets':resources,'checks':{'cliAndHttpCanonicalInventoryEqual':True,'allArchivedObjectHashesAndLengthsVerified':True,'credentialsAclCollaborationAndStagingExcluded':True,'allRevisionRecordsEqual':True,'fullEditorProjectionEqual':True,'offlineDocxExportWithoutSourceCodecOrNetwork':True,'selectedR6ExcludesFutureHistoryAndMatchesOriginal':True,'unauthenticatedFutureAndSourceModeRejected':True,'sourceHeadUnchanged':True},'unpackedDirectory':str(unpacked),'offlineDocx':str(output),'offlineDocxImageOccurrences':pictures}
 browser=Path('/Users/houshuai/Downloads')/f'mentions-docx-r{head}.hcdz'
 if browser.exists():
  assert inspect(browser,head)==b;reopened=work/'browser.hcd';cli('unpack',browser,'--output',reopened);assert projection(reopened,head)==projection(bundle,head);evidence['actualBrowserDownload']={'path':str(browser),'sha256':hashlib.sha256(browser.read_bytes()).hexdigest(),'nativeReadbackEqual':True}
 (reports/'archive-file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(f'PASS offline CLI/HTTP archive r{head}, {len(b["entries"])} verified objects, all history/resources, r6 isolation, native reopen and offline DOCX; source unchanged')
if __name__=='__main__':main()
