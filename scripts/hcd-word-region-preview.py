#!/usr/bin/env python3
"""Owned regional Word preview; all identities/documents are disposable fixtures.
No changes to any existing user preview. Credentials never printed.
"""
import argparse,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path


def main():
    repo=Path(__file__).resolve().parents[1]
    parser=argparse.ArgumentParser();parser.add_argument('--editor-root',type=Path,default=repo/'examples/hdoc/editor');parser.add_argument('--standard-page-margins',action='store_true');parser.add_argument('--mixed-variant',action='store_true',help='Bind second-section first-page header and footer to their inherited default stories');parser.add_argument('--continuous-page-number',action='store_true',help='Remove the second section page number restart');parser.add_argument('--shared-even-header',action='store_true',help='Bind the second section even header to its inherited default header');parser.add_argument('--long-first-section',action='store_true',help='Add many paragraphs before the first section break');parser.add_argument('--first-section-count',type=int,default=140,help='Paragraph count used with --long-first-section');parser.add_argument('--tall-disabled-first-header',action='store_true',help='Use a tall inactive first-page header in the first section');parser.add_argument('--many-sections',action='store_true',help='Create 140 sections so story locations extend past the first index page');parser.add_argument('--disable-even-headers',action='store_true',help='Use default stories on every page for follow-location tests')
    parser.add_argument('--retain-source',action='store_true',help='Keep the exact fixture DOCX for source-backed export')
    parser.add_argument('--unique-final-header',action='store_true',help='Give the last of the 140 sections its own header')
    parser.add_argument('--fail-export-options-once',action='store_true',help='Inject one 503 from the preview proxy for export preflight')
    parser.add_argument('--fail-export-capabilities-once',action='store_true',help='Inject one 503 from the preview proxy for export compatibility')
    args=parser.parse_args()
    if args.unique_final_header and not args.many_sections:parser.error('--unique-final-header requires --many-sections')
    editor=args.editor_root.resolve();binary=repo/'target/debug/officecli'
    root=Path(tempfile.mkdtemp(prefix='word-region-preview-',dir=repo/'target/hcd-preview-runtime'))
    env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):
        completed=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True)
        return json.loads(completed.stdout)['data']
    source=root/'source.docx';template=repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx'
    with zipfile.ZipFile(template) as original,zipfile.ZipFile(source,'w') as generated:
        for name in original.namelist():
            content=original.read(name)
            if name=='word/settings.xml' and args.disable_even_headers:
                content=content.replace(b'<w:evenAndOddHeaders/>',b'')
            if name=='word/parts/custom.xml' and args.tall_disabled_first_header:
                content=content.decode().replace('</w:hdr>',''.join(f'<w:p><w:r><w:t>Disabled first header {i}</w:t></w:r></w:p>' for i in range(30))+'</w:hdr>').encode()
            if name=='word/header1.xml':
                content=content.decode().replace('</w:hdr>','<w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p></w:hdr>').encode()
            elif name=='word/document.xml':
                text=content.decode()
                if args.standard_page_margins:text=text.replace('w:top="-120"','w:top="1440"')
                if args.tall_disabled_first_header:text=text.replace('<w:titlePg/>','',1)
                if args.continuous_page_number:text=text.replace('<w:pgNumType w:start="4" w:fmt="decimal"/>','<w:pgNumType w:fmt="decimal"/>')
                if args.shared_even_header:text=text.replace('<w:headerReference w:type="even" r:id="he"/>','<w:headerReference w:type="even" r:id="hd"/>')
                if args.long_first_section:text=text.replace('<w:body>','<w:body>'+''.join(f'<w:p><w:r><w:t>First section {i:03} — navigation and document layout verification.</w:t></w:r></w:p>' for i in range(1,args.first_section_count+1)),1)
                if args.many_sections:
                    start=text.index('<w:body>')+len('<w:body>');end=text.index('</w:body>',start)
                    boundary='<w:sectPr><w:headerReference w:type="default" r:id="hd"/><w:footerReference w:type="default" r:id="fd"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
                    paragraphs=''.join(f'<w:p w14:paraId="{i:08X}"><w:pPr>{boundary}</w:pPr><w:r><w:t>Section {i} content</w:t></w:r></w:p>' for i in range(1,140))
                    final_boundary=boundary.replace('r:id="hd"','r:id="hf"') if args.unique_final_header else boundary
                    text=text[:start]+paragraphs+'<w:p><w:r><w:t>Section 140 content</w:t></w:r></w:p>'+final_boundary+text[end:]
                    content=text.encode();generated.writestr(name,content);continue
                at=text.rfind('<w:sectPr')
                if args.mixed_variant:
                    text=text[:at]+text[at:].replace('<w:sectPr>','<w:sectPr><w:headerReference w:type="first" r:id="hd"/>',1).replace('<w:footerReference w:type="first" r:id="ff"/>','<w:footerReference w:type="first" r:id="fd"/>',1)
                paragraphs=''.join(f'<w:p><w:r><w:t>Long section {i:03} — 协作位置与按需加载。 The regional document keeps saved body and header identities.</w:t></w:r></w:p>' for i in range(1,141))
                content=(text[:at]+paragraphs+text[at:]).encode()
            generated.writestr(name,content)
    bundle=root/'region-ui.hcd';cli('import',source,'--word-regions','--document-id','region-ui','--output',bundle);cli('project-editor',bundle,'--word-regions','--expected-revision',0)
    if args.retain_source:
        (root/'sources').mkdir();shutil.copyfile(source,root/'sources/region-ui.docx')
    tokens={person:cli('issue-token','--document-id','region-ui','--scope','read' if person=='reader' else 'write','--user-id',person,'--display-name',label,'--ttl-seconds',3600)['token'] for person,label in [('alice','Alice 王'),('bob','Bob 李'),('reader','Reader 访客')]}
    ports=[]
    for _ in range(3):
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
    api,collab,vite=ports
    env.update(HCD_API_URL=f'http://127.0.0.1:{api}',HCD_COLLAB_PORT=str(collab),HCD_SIDECAR_STATE_DIR=str(root/'sidecar'))
    config=root/'preview.config.ts'
    fail_flag=root/'fail-export-options-once'
    capability_fail_flag=root/'fail-export-capabilities-once'
    if args.fail_export_options_once: fail_flag.touch()
    if args.fail_export_capabilities_once: capability_fail_flag.touch()
    config.write_text('import {existsSync,unlinkSync} from "node:fs";\nconst settings='+json.dumps({'root':str(editor),'server':{'port':vite,'host':'127.0.0.1','strictPort':True,'fs':{'allow':[str(repo)]},'proxy':{'/v1':{'target':f'http://127.0.0.1:{api}','ws':True},'/health':f'http://127.0.0.1:{api}'}}})+';\nexport default {...settings,plugins:[{name:"fixture-export-failure",configureServer(server){server.middlewares.use((req,res,next)=>{const optionsFlag='+json.dumps(str(fail_flag))+';const capabilitiesFlag='+json.dumps(str(capability_fail_flag))+';const flag=req.url?.includes("/export-options")?optionsFlag:req.url?.includes("/export-capabilities")?capabilitiesFlag:null;if(flag&&existsSync(flag)){unlinkSync(flag);res.statusCode=503;res.setHeader("content-type","application/json");res.end(JSON.stringify({error:"injected preview failure"}));return}next()})}}]};')
    pages={}
    for person,suffix in [('alice','writer'),('bob','peer'),('reader','reader')]:
        name=f'.hcd-word-region-{root.name.rsplit("-",1)[-1]}-{suffix}.html';page=editor/name
        props={'documentId':'region-ui','token':tokens[person],'apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{collab}','locale':'zh-CN'}
        page.write_text('<!doctype html><html><head><meta charset="UTF-8"><title>Word regions '+suffix+'</title><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style></head><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(EmbeddedHcdEditor,'+json.dumps(props,ensure_ascii=False)+'));</script></body></html>')
        pages[suffix]=f'http://127.0.0.1:{vite}/{name}'
    private=root/'private.json';private.write_text(json.dumps({'root':str(root),'ports':ports,'tokens':tokens,'secret':env['HCD_TOKEN_SECRET'],'pages':pages}));private.chmod(0o600)
    children=[];logs=[]
    try:
        for command,label,cwd in [([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{api}'],'native',root),([str(editor/'node_modules/.bin/tsx'),'sidecar.ts'],'sidecar',editor),([str(editor/'node_modules/.bin/vite'),'--config',str(config)],'vite',editor)]:
            log=open(root/(label+'.log'),'w');logs.append(log);children.append(subprocess.Popen(command,cwd=cwd,env=env,stdout=log,stderr=log))
        deadline=time.monotonic()+45
        while True:
            assert all(child.poll() is None for child in children),'Owned preview service exited'
            try:
                if urllib.request.urlopen(f'http://127.0.0.1:{vite}/health',timeout=2).status==200:break
            except Exception:pass
            assert time.monotonic()<deadline,'Owned preview did not become ready'
            time.sleep(.1)
        print(json.dumps({'root':str(root),**pages},ensure_ascii=False),flush=True)
        while all(child.poll() is None for child in children):time.sleep(.5)
    finally:
        for child in children:
            if child.poll() is None:child.terminate()
        for child in children:
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        for log in logs:log.close()

if __name__=='__main__':main()
