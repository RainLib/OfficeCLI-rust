#!/usr/bin/env python3
"""Read back an owned recovery-UI preview; never publish or print credentials."""
import base64
import gzip
import hashlib
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from html.parser import HTMLParser


class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]; self.skip=0
    def handle_starttag(self, tag, attrs):
        if tag in ['style','script']: self.skip+=1
    def handle_endtag(self, tag):
        if tag in ['style','script']: self.skip-=1
    def handle_data(self, value):
        if not self.skip: self.parts.append(value)


def main():
    repo=Path(__file__).resolve().parents[1]
    config=json.loads(Path(sys.argv[1]).read_text()); root=Path(config['root'])
    assert root.name.startswith('hcd-mention-preview-')
    binary=repo/'target/debug/officecli'; bundle=root/'mentions-docx.hcd'
    before=(bundle/'manifest.json').read_bytes(); head=json.loads(before)['revision']
    assert head>=4
    fixture=json.loads((root/'recovery-files/file-fixture-evidence.json').read_text())
    evidence=repo/'docs/assets/hcd-semantic-recovery-ui-2026-10-27'; evidence.mkdir(exist_ok=True)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(path, data=None, token='reader'):
        headers={'X-HCD-Node-Edits-Version':'4'}
        if token: headers['Authorization']='Bearer '+config[token]
        if data is not None: headers['Content-Type']='application/octet-stream'
        req=urllib.request.Request(config['origin']+'/v1/documents/mentions-docx'+path,data=data,headers=headers)
        try:
            with opener.open(req, timeout=120) as response: return response.status,response.read()
        except urllib.error.HTTPError as error: return error.code,error.read()
    def cli(*args):
        return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
    def checked_bytes(value):
        raw=base64.b64decode(value['base64'],validate=True)
        assert len(raw)==value['byteLength'] and hashlib.sha256(raw).hexdigest()==value['sha256']
        return raw
    original=Path('/Users/houshuai/Downloads/mentions-docx.hcd-recovery').read_bytes()
    packet=json.loads(original); canonical=checked_bytes(packet['canonical']); scope=packet['scope']
    query=urllib.parse.urlencode({key:scope[key] for key in ['revision','rootHash','epoch']})
    path='/recovery/canonical/inspect?'+query
    statuses={}
    status,raw=request(path,canonical); assert status==200,(status,raw)
    receipt=json.loads(raw); assert receipt['verified'] and receipt['sha256']==hashlib.sha256(canonical).hexdigest()
    statuses['readerCanonical']=status
    status,_=request(path,canonical,token=None); assert status==401; statuses['noToken']=status
    status,_=request(path.replace('epoch=1','epoch=9999'),canonical); assert status==409; statuses['wrongEpoch']=status
    status,raw=request(path,b'X'*(9*1024*1024)); assert status==400,(status,raw[:200]); statuses['nineMiBInvalidZip']=status
    retained=json.loads(Path('/Users/houshuai/Downloads/mentions-docx (1).hcd-recovery').read_text())
    assert len(retained['pendingFiles'])==1
    pending=retained['pendingFiles'][0]; assert pending['resource']==fixture['pendingResource'] and pending['phase']=='chosen'
    resources={value['sha256']:checked_bytes(value) for value in retained['resources']}
    assert resources[fixture['pendingResource']['hash']]=='未完成文件待确认原始字节 😀'.encode()
    assert resources[fixture['resource']['hash']]=='恢复包附件原始字节 😀'.encode()
    state=cli('editor-state',bundle,'--revision',head)
    text=json.dumps(state,ensure_ascii=False)
    labels=['Bob同','比较后输入保留','当前草稿新增😀','文件中新增的段落😀']
    assert all(value in text for value in labels)
    assert fixture['resource']['hash'] in text and fixture['pendingResource']['hash'] not in text
    files=[]
    for fmt in ['docx','pdf','pptx','xlsx','html','md','txt','hcdz']:
        status,raw=request(f'/export/{fmt}?revision={head}'); assert status==200,(fmt,status,raw[:200])
        output=evidence/f'recovered-r{head}.{fmt}'; output.write_bytes(raw)
        if fmt=='hcdz':
            offline=root/f'recovery-ui-offline-r{head}.hcd'
            if not offline.exists(): cli('unpack',output,'--output',offline)
            assert cli('editor-state',offline,'--revision',head)==state
            record=json.loads((offline/f'revisions/{head:020}.json').read_text())
            index_bytes=(offline/record['assetIndexHref']).read_bytes()
            index=json.loads(gzip.decompress(index_bytes) if index_bytes.startswith(b'\x1f\x8b') else index_bytes)
            asset=next(value for value in index if value['hash']==fixture['resource']['hash'])
            assert (offline/asset['href']).read_bytes()==resources[asset['hash']]
            assert not any(value['hash']==fixture['pendingResource']['hash'] for value in index)
            offline_export=evidence/f'offline-r{head}.docx'
            cli('export',offline,'--output',offline_export,'--to','docx','--revision',head)
            offline_text=subprocess.check_output([str(binary),'view',str(offline_export),'text'],text=True)
            assert all(value in offline_text for value in labels)
            assert offline_text.count('导出资料：恢复附件')==1
            decoded=''
        elif fmt in ['md','txt']: decoded=raw.decode()
        elif fmt=='html': parser=Text();parser.feed(raw.decode());decoded=''.join(parser.parts)
        else: decoded=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
        if fmt!='hcdz':
            assert all(value in decoded for value in labels),(fmt,decoded)
            assert decoded.count('导出资料：恢复附件')==1,(fmt,decoded)
            assert '未完成文件待确认' not in decoded and '待确认附件.txt' not in decoded
            assert all(name not in decoded for name in ['Alice 王','Bob 李','Reader 访客'])
        files.append({'format':fmt,'path':str(output.relative_to(repo)),'sha256':hashlib.sha256(raw).hexdigest(),'byteLength':len(raw)})
    assert (bundle/'manifest.json').read_bytes()==before
    result={'scope':'Actual local UI download/import and dual-browser collaboration, native HTTP/CLI and offline files. No production or desktop Office visual acceptance.','head':head,'http':statuses,'files':files,'retainedPendingBytes':True,'committedResourceBytes':True,'pendingNotCommittedOrExported':True,'readbackDidNotChangeHead':True,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
    (evidence/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(f'PASS r{head}: reader verification, 9 MiB route limit, retained pending bytes, eight exports and offline resource readback')


if __name__=='__main__': main()
