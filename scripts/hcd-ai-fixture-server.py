#!/usr/bin/env python3
"""Loopback synthetic NDJSON provider for disposable HCD browser fixtures.
No external model, credentials, production access or generic proxy capability.
"""
import argparse,json,re,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,required=True);parser.add_argument('--root',required=True);args=parser.parse_args();root=Path(args.root)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def do_POST(self):
  try:
   length=int(self.headers.get('Content-Length','0'))
   if self.path!='/hcd-test-ai' or not 0<length<=65536:self.send_error(400);return
   request=json.loads(self.rfile.read(length));request_id=request.get('requestId','')
   if request.get('version')!='hcd-ai/1' or not re.fullmatch(r'[a-f0-9-]{36}',request_id) or any(key in request for key in ['token','anchor','user','userId']):self.send_error(400);return
   (root/f'ai-request-{request_id}.json').write_text(json.dumps(request,ensure_ascii=False))
   self.send_response(200);self.send_header('Content-Type','application/x-ndjson; charset=utf-8');self.send_header('Cache-Control','no-store');self.end_headers()
   instruction=request.get('instruction','');slow='慢速' in instruction
   automatic=request.get('action')=='hcd.autocomplete'
   if automatic:slow=True
   text=' 自动补全验证。' if automatic else ' AI 续写验证：新增说明。' if request.get('mode')=='insert' else 'AI 改写验证：内容更清晰。'
   chunks=[text[index:index+(1 if slow else 3)] for index in range(0,len(text),1 if slow else 3)]
   for seq,chunk in enumerate(chunks):
    self.wfile.write((json.dumps({'version':'hcd-ai/1','requestId':request_id,'seq':seq,'type':'delta','text':chunk},ensure_ascii=False)+'\n').encode());self.wfile.flush();time.sleep(.3 if slow else .12)
   self.wfile.write((json.dumps({'version':'hcd-ai/1','requestId':request_id,'seq':len(chunks),'type':'done'})+'\n').encode());self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
