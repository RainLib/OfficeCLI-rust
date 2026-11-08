#!/usr/bin/env python3
"""Read-only export lifecycle check against a clone of the owned long-word fixture.
Usage: python3 scripts/hcd-export-lifecycle.py <preview-private.json>
No browser automation and no bearer tokens are printed or written to evidence.
"""
import concurrent.futures,hashlib,json,os,shutil,socket,subprocess,sys,tempfile,threading,time,urllib.error,urllib.request
from pathlib import Path

def main():
    repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());source=Path(config['root']);root=Path(tempfile.mkdtemp(prefix='hcd-export-lifecycle-'));root.chmod(0o700)
    shutil.copytree(source/'mentions-docx.hcd',root/'mentions-docx.hcd');(root/'scratch').mkdir()
    def digest():
        return hashlib.sha256(b''.join(str(p.relative_to(root)).encode()+hashlib.sha256(p.read_bytes()).digest() for p in sorted((root/'mentions-docx.hcd').rglob('*')) if p.is_file())).hexdigest()
    initial=digest();opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));binary=repo/'target/debug/officecli'
    env={**os.environ,'HCD_TOKEN_SECRET':config['secret'],'TMPDIR':str(root/'scratch')}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def children(pid):
        return [int(line.split()[0]) for line in subprocess.check_output(['ps','-axo','pid=,ppid='],text=True).splitlines() if line.split() and int(line.split()[1])==pid]
    def serve(seconds,run):
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        with (root/f'server-{seconds}.log').open('w') as log:
            server=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env={**env,'HCD_HTTP_EXPORT_TIMEOUT_SECONDS':str(seconds)},stdout=log,stderr=log)
            origin=f'http://127.0.0.1:{port}'
            try:
                for _ in range(200):
                    if server.poll() is not None:raise RuntimeError('isolated server stopped')
                    try:
                        opener.open(origin+'/health',timeout=1).close();break
                    except OSError:time.sleep(.05)
                else:raise RuntimeError('isolated server did not listen')
                def request(route):
                    req=urllib.request.Request(origin+'/v1/documents/mentions-docx'+route,headers={'Authorization':'Bearer '+config['reader']})
                    start=time.monotonic()
                    try:
                        with opener.open(req,timeout=90) as response:return response.status,response.read(),round(time.monotonic()-start,3)
                    except urllib.error.HTTPError as error:return error.code,error.read(),round(time.monotonic()-start,3)
                return run(request,server.pid)
            finally:
                server.terminate()
                try:server.wait(timeout=10)
                except subprocess.TimeoutExpired:server.kill();server.wait()
    def timed_out(request,pid):
        barrier=threading.Barrier(3)
        def attempt(_):barrier.wait();return request('/export/pdf?revision=2')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(attempt,range(3)))
        assert sorted(code for code,_,_ in results)==[429,504,504],[(code,data[:100]) for code,data,_ in results]
        for _ in range(100):
            if not children(pid):break
            time.sleep(.02)
        assert not children(pid),'timed-out exporter remains alive'
        assert not list((root/'scratch').iterdir()),'temporary export remains after deadline'
        assert digest()==initial
        return {'statuses':sorted(code for code,_,_ in results),'durationsSeconds':[seconds for _,_,seconds in results],'noRemainingExportChildren':True,'temporaryOutputsCleaned':True,'canonicalBundleUnchanged':True}
    timeout_result=serve(1,timed_out)
    def succeeded(request,_pid):
        code,data,seconds=request('/export/pdf?revision=2');assert code==200,(code,data[:100]);path=root/'final.pdf';path.write_bytes(data)
        text=subprocess.check_output(['pdftotext','-layout',str(path),'-'],text=True)
        assert text.count('@张三')==2 and text.count('定位段落')==80 and text.count('·')==6400,{'mentions':text.count('@张三'),'paragraphs':text.count('定位段落'),'dots':text.count('·')}
        assert '张四' not in text and 'Alice 王' not in text and digest()==initial
        destination=repo/'docs/assets/hcd-mentions-2026-10-24/long-rich-export.pdf';destination.write_bytes(data)
        return {'httpStatus':code,'seconds':seconds,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'paragraphs':80,'mentions':2,'alternatingStyledDots':6400,'canonicalBundleUnchanged':True}
    success_result=serve(300,succeeded)
    result={'schemaVersion':'hcd-export-lifecycle/1','scope':'Isolated local native server, cloned synthetic long document, read token; not production capacity or external deployment acceptance.','timeoutAndConcurrency':timeout_result,'success':success_result,'retainedFixture':str(root)}
    target=repo/'docs/assets/hcd-mentions-2026-10-24/export-lifecycle-api-evidence.json';target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print('PASS native read-only export, 429/504 cleanup and actual long PDF readback')

if __name__=='__main__':main()
