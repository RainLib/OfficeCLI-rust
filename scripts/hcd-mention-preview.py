#!/usr/bin/env python3
"""Isolated localhost browser fixture for the default people mention menu.
Creates only disposable fixture identities; prints no bearer tokens.
"""
import argparse,json,os,re,runpy,secrets,shutil,signal,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--isolated-editor',action='store_true',help='copy frontend into the owned fixture before starting');parser.add_argument('--custom-marks',action='store_true',help='public custom text-mark registration with owned unload/reload controls');parser.add_argument('--short-references',action='store_true',help='two mentions without the long-document paragraphs');parser.add_argument('--resource-probe',action='store_true',help='owned delayed-resource HTTP proxy; fresh fixture only');parser.add_argument('--autocomplete',action='store_true',help='synthetic AI with explicit opt-in ghost completion');parser.add_argument('--ai',action='store_true',help='synthetic loopback AI provider; no external model');parser.add_argument('--long-document',action='store_true');parser.add_argument('--extension-nodes',action='store_true');parser.add_argument('--node-sdk',action='store_true');parser.add_argument('--node-portable',action='store_true');parser.add_argument('--node-migrations',action='store_true');parser.add_argument('--node-conflicts',action='store_true');parser.add_argument('--source-html',type=Path,help='copy an owned HTML fixture into a fresh isolated preview');parser.add_argument('--source-docx',type=Path,help='copy an owned DOCX fixture into a fresh isolated preview');parser.add_argument('--reuse-root');parser.add_argument('--runtime-dir',type=Path,help='optional durable, git-ignored directory for owned validation fixtures');parser.add_argument('--pages-prefix',default='.hcd-mention-docx');parser.add_argument('--node-history',action='store_true',help='owned public-API codec unload/reload controls');parser.add_argument('--checkpoint-probe',action='store_true',help='owned checkpoint request/error capture proxy');args=parser.parse_args();args.node_portable=args.node_portable or args.node_history;args.long_document=args.long_document or args.short_references;args.ai=args.ai or args.autocomplete;args.node_sdk=args.node_sdk or args.node_migrations or args.node_portable;args.node_conflicts=args.node_conflicts or args.node_migrations
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',args.pages_prefix):raise ValueError('invalid page prefix')
    repo=Path(__file__).resolve().parents[1];editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli'
    if args.runtime_dir:args.runtime_dir=args.runtime_dir.resolve();args.runtime_dir.mkdir(parents=True,exist_ok=True);args.runtime_dir.chmod(0o700)
    root=Path(args.reuse_root) if args.reuse_root else Path(tempfile.mkdtemp(prefix='hcd-mention-preview-',dir=args.runtime_dir));root.chmod(0o700)
    previous=json.loads((root/'private.json').read_text()) if args.reuse_root else None
    if args.isolated_editor:
        isolated=root/'editor'
        if isolated.exists():raise ValueError('isolated editor already exists; preserve the existing runtime')
        shutil.copytree(editor,isolated,ignore=shutil.ignore_patterns('node_modules','dist','dist-embed','.hcd-*','screenshots'))
        (isolated/'node_modules').symlink_to(editor/'node_modules',target_is_directory=True);editor=isolated
    if previous and (previous['root']!=str(root) or not root.name.startswith('hcd-mention-preview-')):raise ValueError('not an owned preview fixture')
    if previous and isinstance(previous.get('previewPid'),int):
        try:os.kill(previous['previewPid'],0)
        except ProcessLookupError:pass
        else:raise RuntimeError('owned preview is still running; wait for its process to exit before reusing this root')
    owner=secrets.token_hex(16)
    if args.resource_probe and (args.ai or previous):raise ValueError('resource probe requires a fresh non-AI fixture')
    if args.checkpoint_probe and (args.ai or args.resource_probe or previous):raise ValueError('checkpoint probe requires a fresh standalone fixture')
    if args.source_docx and args.source_html:raise ValueError('select one source fixture')
    if (args.source_docx or args.source_html) and previous:raise ValueError('source overrides require a fresh fixture root')
    source_format='html' if args.source_html else 'docx'
    if not previous:runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
    if args.node_portable and not previous:
        with zipfile.ZipFile(root/'fixture.docx') as source:
            image=next(name for name in source.namelist() if name.startswith('word/media/') and name.endswith('.png'))
            (root/'archived-image.png').write_bytes(source.read(image))
        (root/'offline-notes.bin').write_bytes('离线资源内容 · portable archive\n'.encode())
        (root/'ui-archive.txt').write_text('页面归档 · 离线资源\n')
    if args.source_docx:
        if not args.source_docx.is_file() or args.source_docx.suffix.lower()!='.docx':raise ValueError('source fixture must be a DOCX file')
        shutil.copyfile(args.source_docx,root/'fixture.docx')
    if args.source_html:
        if not args.source_html.is_file() or args.source_html.suffix.lower() not in ['.html','.htm']:raise ValueError('source fixture must be HTML')
        shutil.copyfile(args.source_html,root/'fixture.html')
    env={**os.environ,'HCD_TOKEN_SECRET':previous['secret'] if previous else secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    if not previous:cli('import',root/f'fixture.{source_format}','--output',root/'mentions-docx.hcd','--document-id','mentions-docx');cli('project-editor',root/'mentions-docx.hcd','--expected-revision',0);(root/'sources').mkdir();(root/f'sources/mentions-docx.{source_format}').write_bytes((root/f'fixture.{source_format}').read_bytes())
    ports=previous['ports'] if previous else []
    for _ in range(0 if previous else (4 if args.ai or args.resource_probe or args.checkpoint_probe else 3)):
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
    people=[{'id':'person:产品/甲','label':'张三','detail':'产品组 · 离线成员','active':True},{'id':'person:设计/乙','label':'张三','detail':'设计组 · 离线成员','active':True},{'id':'alice','label':'Alice 王','detail':'文档编辑者','active':True},{'id':'bob','label':'Bob 李','detail':'文档编辑者','active':True}]+[{'id':f'person-{n}','label':f'Test member {n:02}','detail':'测试目录','active':True} for n in range(25)]
    if not previous:(root/'people').mkdir();(root/'people/mentions-docx.json').write_text(json.dumps({'schemaVersion':'hcd-people/1','generation':1,'people':people},ensure_ascii=False))
    tokens={user:cli('issue-token','--document-id','mentions-docx','--scope','read' if user=='reader' else 'write','--user-id',user,'--display-name',name,'--ttl-seconds',3600)['token'] for user,name in [('alice','Alice 王'),('bob','Bob 李'),('reader','Reader 访客')]}
    origin=f'http://127.0.0.1:{ports[0]}'
    private=root/'private.json';private.write_text(json.dumps({'root':str(root),'origin':origin,'alice':tokens['alice'],'bob':tokens['bob'],'reader':tokens['reader'],'secret':env['HCD_TOKEN_SECRET'],'ports':ports,'previewPid':os.getpid(),'previewOwner':owner}));private.chmod(0o600)
    pages=[]
    for actor,suffix in [('alice','writer'),('bob','peer'),('reader','reader')]:
        path=editor/f'{args.pages_prefix}-{suffix}.html';pages.append(path)
        props={'documentId':'mentions-docx','token':tokens[actor],'apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}','locale':'zh-CN'}
        auto_options=',autocomplete:{enabled:false,delayMs:500,cooldownMs:700,minPrefix:4,maxOutput:128}' if args.autocomplete else ''
        ai='import{createHttpAiProvider}from"/src/ai/http.ts";const aiExtensions={provider:createHttpAiProvider({url:"/hcd-test-ai"})'+auto_options+'};' if args.ai else 'const aiExtensions=undefined;'
        sdk='import{nodeSdkFixture}from"/fixtures/nodeSdk.ts";const nodeExtensions={nodes:nodeSdkFixture,onError:error=>console.error(error)};' if args.node_sdk and actor!='reader' else 'const nodeExtensions=undefined;'
        if args.node_portable:sdk=sdk.replace('import{nodeSdkFixture}from"/fixtures/nodeSdk.ts"','import{nodePortableFixture as nodeSdkFixture}from"/fixtures/nodePortable.ts"')
        if args.node_migrations:sdk=sdk.replace('import{nodeSdkFixture}from\"/fixtures/nodeSdk.ts\"','import{nodeMigrationsFixture as nodeSdkFixture}from\"/fixtures/nodeMigrations.ts\"')
        if args.node_history and actor!='reader':sdk='import{createNodeHistoryFixture}from"/fixtures/nodeHistory.ts";const nodeExtensions=createNodeHistoryFixture();'
        if args.custom_marks and actor!='reader':sdk='import{createCustomMarksFixture}from"/fixtures/customMarks.ts";const nodeExtensions=createCustomMarksFixture();'
        path.write_text('<!-- hcd-preview:'+owner+' --><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style><div id="root"></div><script type="module">import React from"react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";'+sdk+ai+'createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode,null,React.createElement(EmbeddedHcdEditor,{...'+json.dumps(props,ensure_ascii=False)+',nodeExtensions,aiExtensions})));</script>');path.chmod(0o600)
    config=root/'vite.config.mjs';config.write_text('export default '+json.dumps({'root':str(editor),'server':{'host':'127.0.0.1','port':ports[2],'strictPort':True,'fs':{'allow':[str(repo),str(root)]},'proxy':{'/v1':{'target':origin,'ws':True}}}}))
    if args.resource_probe:
        (root/'resource-control.json').write_text(json.dumps({'mode':'pass','release':0}))
        settings=json.loads(config.read_text().removeprefix('export default '));settings['server']['proxy']['/v1']['target']=f'http://127.0.0.1:{ports[3]}';config.write_text('export default '+json.dumps(settings))
    if args.ai:
        if len(ports)!=4:raise ValueError('AI fixture requires a fresh owned root')
        settings=json.loads(config.read_text().removeprefix('export default '));settings['server']['proxy']['/hcd-test-ai']={'target':f'http://127.0.0.1:{ports[3]}'};config.write_text('export default '+json.dumps(settings))
    children=[];logs=[]
    def start(args,extra=None):
        log=open(root/f'service-{len(children)}.log','ab');logs.append(log);child=subprocess.Popen(args,cwd=editor,env={**env,**(extra or {})},stdout=log,stderr=log);children.append(child)
    signal.signal(signal.SIGTERM,lambda *_:exit(0))
    try:
        start([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'])
        start(['node','--import','tsx','sidecar.ts'],{'HCD_API_URL':f'http://127.0.0.1:{ports[3]}' if args.checkpoint_probe else origin,'HCD_COLLAB_PORT':str(ports[1]),'HCD_COLLAB_BIND':'127.0.0.1','HCD_SIDECAR_STATE_DIR':str(root/'sidecar-state')})
        if args.checkpoint_probe:start(['node',str(repo/'scripts/hcd-checkpoint-probe.mjs'),str(ports[3]),str(ports[0]),str(root)])
        if args.resource_probe:start(['node',str(repo/'scripts/hcd-resource-probe.mjs'),str(ports[3]),str(ports[0]),str(root)])
        if args.ai:start(['python3',str(repo/'scripts/hcd-ai-fixture-server.py'),'--port',str(ports[3]),'--root',str(root)])
        start(['node',str(editor/'node_modules/vite/bin/vite.js'),'--config',str(config)])
        for port in ports:
            for _ in range(200):
                with socket.socket() as probe:
                    if probe.connect_ex(('127.0.0.1',port))==0:break
                if any(child.poll() is not None for child in children):raise RuntimeError('preview service stopped; logs retained at '+str(root))
                time.sleep(.1)
            else:raise RuntimeError('preview did not listen')
        if args.long_document and not previous:
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def request(route,body=None):
                req=urllib.request.Request(origin+'/v1/documents/mentions-docx'+route,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers={'Authorization':'Bearer '+tokens['alice'],'Content-Type':'application/json','X-HCD-Reference-Version':'1'})
                return json.load(opener.open(req,timeout=120))
            projection=request('/editor');anchor=projection['blocks'][-1]['blockId']
            def mention(digit,target):return {'kind':'paragraph','inlines':[{'text':'@张三','reference':{'type':'hcd.mention','version':1,'mentionId':'m_'+digit*32,'target':{'kind':'person','id':target},'snapshot':{'label':'张三'}}}]}
            blocks=[mention('a','person:设计/乙')]
            for n in range(0 if args.short_references else 80):
                inlines=[{'text':f'定位段落 {n+1:03d} — '},{'text':'第一行'},{'text':'\n','hardBreak':True},{'text':'第二行'},{'text':'\n','hardBreak':True}]+[{'text':'·','bold':j%2==0} for j in range(80)]
                blocks.append({'kind':'paragraph','inlines':inlines})
            blocks.append(mention('b','person:产品/甲'))
            request('/patch',{'schemaVersion':'hcd-patch/4','documentId':'mentions-docx','patchId':'reference-navigation-fixture','baseRevision':projection['revision'],'actor':{},'operations':[{'op':'block.insert','afterBlockId':anchor,'block':block} for block in reversed(blocks)]})
        if args.extension_nodes and not previous:
            def node(number,display,text):return {'schemaVersion':'hcd.extension/1','instanceId':'x_'+format(number,'032x'),'type':'example.future_card','version':77,'display':display,'data':{'unavailableCodec':{'nested':['原始业务数据',42,True,None]}},'fallback':{'text':text}}
            inline=node(1,'inline','关联项目 · 离线内容');block=node(2,'block','提示：扩展未加载，原始业务数据已保留。')
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));headers={'Authorization':'Bearer '+tokens['alice'],'Content-Type':'application/json','X-HCD-Extension-Version':'2'}
            req=urllib.request.Request(origin+'/v1/documents/mentions-docx/editor',headers=headers);projection=json.load(opener.open(req,timeout=90));anchor=projection['blocks'][-1]['blockId']
            patch={'schemaVersion':'hcd-patch/4','documentId':'mentions-docx','patchId':'generic-extension-fixture','baseRevision':projection['revision'],'actor':{},'operations':[{'op':'block.insert','afterBlockId':anchor,'block':{'kind':'extension','extension':block,'inlines':[{'text':block['fallback']['text']}]}},{'op':'block.insert','afterBlockId':anchor,'block':{'kind':'paragraph','inlines':[{'text':'项目引用：'},{'text':inline['fallback']['text'],'extension':inline}]}},{'op':'block.insert','afterBlockId':anchor,'block':{'kind':'paragraph','inlines':[{'text':'这里可以继续编辑普通正文。'}]}}]}
            opener.open(urllib.request.Request(origin+'/v1/documents/mentions-docx/patch',data=json.dumps(patch).encode(),headers=headers),timeout=90).close()
        if args.node_conflicts and not previous:
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));headers={'Authorization':'Bearer '+tokens['alice'],'Content-Type':'application/json','X-HCD-Extension-Version':'2'}
            projection=json.load(opener.open(urllib.request.Request(origin+'/v1/documents/mentions-docx/editor',headers=headers)));anchor=projection['blocks'][-1]['blockId']
            def known(number,display,kind,title):return {'schemaVersion':'hcd.extension/1','instanceId':'x_'+format(number,'032x'),'type':kind,'version':1,'display':display,'data':{'title':title,'done':False,'priority':1},'fallback':{'text':'☐ '+title}}
            inline=known(3,'inline','example.task','协同基线任务');block=known(4,'block','example.notice','协同基线提示')
            patch={'schemaVersion':'hcd-patch/4','documentId':'mentions-docx','patchId':'node-conflict-fixture','baseRevision':projection['revision'],'actor':{},'operations':[{'op':'block.insert','afterBlockId':anchor,'block':{'kind':'extension','extension':block,'inlines':[{'text':block['fallback']['text']}]}},{'op':'block.insert','afterBlockId':anchor,'block':{'kind':'paragraph','inlines':[{'text':inline['fallback']['text'],'extension':inline}]}}]}
            opener.open(urllib.request.Request(origin+'/v1/documents/mentions-docx/patch',data=json.dumps(patch).encode(),headers=headers),timeout=90).close()
        print(json.dumps({'root':str(root),'writer':f'http://127.0.0.1:{ports[2]}/{pages[0].name}','peer':f'http://127.0.0.1:{ports[2]}/{pages[1].name}','reader':f'http://127.0.0.1:{ports[2]}/{pages[2].name}'},ensure_ascii=False),flush=True)
        while all(child.poll() is None for child in children):time.sleep(1)
    finally:
        for child in children:
            if child.poll() is None:child.terminate()
        for child in children:
            try:child.wait(timeout=10)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        for log in logs:log.close()
        # Fixture bundles remain available for exported-file verification.
        for page in pages:
            if page.is_file() and page.read_text().startswith('<!-- hcd-preview:'+owner+' -->'):page.unlink()
        current=json.loads(private.read_text())
        if current.get('previewOwner')==owner:
            current.pop('previewPid',None);private.write_text(json.dumps(current))

if __name__=='__main__':main()
