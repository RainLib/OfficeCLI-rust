#!/usr/bin/env python3
"""Read/write/checkpoint compatibility fences on an owned local preview.
The negative write resends identical bytes, so even a missing fence cannot erase data.
"""
import hashlib,json,os,subprocess,sys,urllib.request,urllib.error
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());base=c['origin']+'/v1/documents/mentions-docx';required=int(sys.argv[2]) if len(sys.argv)>2 else 4;assert required in [4,5];env={**os.environ,'HCD_TOKEN_SECRET':c['secret']};binary=repo/'target/debug/officecli'
 service=json.loads(subprocess.check_output([str(binary),'hdoc','issue-token','--document-id','mentions-docx','--scope','write','--user-id','hcd-collaboration','--ttl-seconds','300','--json'],env=env))['data']['token'];opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def get(path):return json.load(opener.open(urllib.request.Request(base+path,headers={'Authorization':'Bearer '+c['reader']}),timeout=40))
 auth=get('/auth');head=get('')['revision'];headers={'Authorization':'Bearer '+service,'X-HCD-Collaboration-Epoch':str(auth['collaborationEpoch']),'X-HCD-Collaboration-Protocol':auth['collaborationProtocol'],'X-HCD-Node-Edits-Version':str(required),'X-HCD-Coordinator-Version':'4'}
 before=opener.open(urllib.request.Request(base+'/collaboration/state',headers=headers),timeout=40).read();raw_hash=hashlib.sha256(before).hexdigest()
 def reject(path,body=None,version=None):
  current={**headers,'X-HCD-State-Hash':raw_hash,'Content-Type':'application/json' if path=='/checkpoints' else 'application/octet-stream'}
  if version is None:current.pop('X-HCD-Node-Edits-Version')
  else:current['X-HCD-Node-Edits-Version']=version
  try:opener.open(urllib.request.Request(base+path,data=body,headers=current,method='PUT' if body is not None and path.endswith('/state') else None),timeout=40);raise AssertionError('unaware operation was accepted')
  except urllib.error.HTTPError as error:
   message=json.loads(error.read())['error'];assert error.code==426 and ('node-edit-aware' in message or 'unsupported collaboration node edit model' in message),(error.code,message)
 for version in [None,*map(str,range(1,required))]:
  reject('/collaboration/state',version=version);reject('/collaboration/state',before,version=version);reject('/checkpoints',json.dumps({'coordinatorVersion':4,'expectedRevision':head,'blocks':[]}).encode(),version=version)
 reject('/collaboration/state',version='6')
 after=opener.open(urllib.request.Request(base+'/collaboration/state',headers=headers),timeout=40).read();assert before==after and get('')['revision']==head
 evidence={'schemaVersion':'hcd-node-model-fence/1','scope':'Actual local native API after the aware coordinator persisted its durable model requirement. Optional PostgreSQL adapter compiled, but no live database/older PostgreSQL binary acceptance claim.','revision':head,'requiredModel':required,'rejectedReadPutCheckpointModels':[None,*range(1,required)],'rejectedUnknownModel':6,'validation':{'unawareSharedReadRejected426':True,'unawareIdenticalPutRejected426':True,'unawareCanonicalCheckpointRejected426':True,'unknownModelRejected426':True,'propertyOnlyModel1ReadWriteAndCheckpointRejected426':True,'previousModel2ReadWriteAndCheckpointRejected426':True,'sharedBytesAndCanonicalHeadUnchanged':True},'sharedStateSha256':raw_hash};(Path(sys.argv[3]) if len(sys.argv)>3 else repo/'docs/assets/hcd-node-portable-2026-10-25/portable-model-fence-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print('PASS native model fence: read, identical write, checkpoint and unknown model denied; bytes/head unchanged')
if __name__=='__main__':main()
