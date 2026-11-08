#!/usr/bin/env python3
"""Owned loopback fault proxy. Never writes bearer credentials to reports.
Run against a live hcd-mention-preview fixture. First two requests fail, then
retry forwards to its native API. Other modes remain deterministic failures.
"""
import argparse,json,socket,threading,urllib.request,urllib.error
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);args=p.parse_args()
 private=json.loads((args.root/'private.json').read_text());origin=private['origin'];editor=Path(__file__).resolve().parents[1]/'examples/hdoc/editor'
 ui_origin='http://127.0.0.1:'+str(private['ports'][2]);state={'retry':0};lock=threading.Lock()
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_OPTIONS(self):self.send_response(204);self.headers_();self.end_headers()
  def headers_(self):
   self.send_header('Access-Control-Allow-Origin',ui_origin);self.send_header('Access-Control-Allow-Headers','Authorization,X-HCD-Collaboration-Epoch,X-HCD-Collaboration-Protocol,X-HCD-Node-Edits-Version,X-HCD-Custom-Marks-Version,X-HCD-Extension-Version,Content-Type');self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  def do_POST(self):self.do_GET()
  def do_GET(self):
   mode,_,path=self.path.lstrip('/').partition('/')
   with lock:
    fail=mode=='retry' and state['retry']<2
    if mode=='retry':state['retry']+=1
   if fail or mode in ['denied','invalid','upgrade']:
    self.send_response(503 if fail else 403 if mode=='denied' else 426 if mode=='upgrade' else 200);self.headers_();self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{invalid' if mode=='invalid' else b'PRIVATE_BACKEND_DETAIL_DO_NOT_DISPLAY');return
   if mode!='retry' or not path.startswith('v1/documents/mentions-docx'):
    self.send_response(404);self.end_headers();return
   try:
    length=int(self.headers.get('Content-Length','0'))
    if length>8*1024*1024:raise ValueError('body too large')
    data=self.rfile.read(length) if self.command=='POST' else None
    request=urllib.request.Request(origin+'/'+path,data=data,method=self.command,headers={key:value for key,value in self.headers.items() if key.lower() not in ['host','origin','connection']})
    with urllib.request.urlopen(request,timeout=45) as response:status=response.status;body=response.read();content=response.headers.get('Content-Type','application/octet-stream')
   except urllib.error.HTTPError as error:status=error.code;body=error.read();content=error.headers.get('Content-Type','application/octet-stream')
   except Exception:status=502;body=b'LOCAL_PROXY_UNAVAILABLE';content='text/plain'
   self.send_response(status);self.headers_();self.send_header('Content-Type',content);self.end_headers();self.wfile.write(body)
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);proxy='http://127.0.0.1:'+str(server.server_port);pages=[]
 for mode in ['retry','denied','invalid','upgrade']:
  props={'documentId':'mentions-docx','token':private['alice'],'apiUrl':proxy+'/'+mode+'/v1/documents','collabUrl':'ws://127.0.0.1:'+str(private['ports'][1]),'locale':'zh-CN'}
  page=editor/('.hcd-errors-'+mode+'.html');pages.append(page)
  page.write_text('<!-- owned-document-problem-fixture -->\n<!doctype html><html><head><meta charset="utf-8"><title>HCD error '+mode+'</title><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(EmbeddedHcdEditor,'+json.dumps(props,ensure_ascii=False)+'));</script></body></html>');page.chmod(0o600)
 print(json.dumps({'gallery':ui_origin+'/document-problems.html','pages':{mode:ui_origin+'/.hcd-errors-'+mode+'.html' for mode in ['retry','denied','invalid','upgrade']}},ensure_ascii=False),flush=True)
 try:server.serve_forever()
 finally:
  server.server_close()
  for page in pages:
   if page.is_file() and page.read_text().startswith('<!-- owned-document-problem-fixture -->'):page.unlink()
if __name__=='__main__':main()
