#!/usr/bin/env python3
"""Audit the owned custom-mark evidence without copying credentials into reports."""
import base64,binascii,datetime,gzip,hashlib,io,json,re,shutil,sys,zipfile
from pathlib import Path
from zoneinfo import ZoneInfo

def main():
 repo=Path(__file__).resolve().parents[1];runtime=repo/'target/hcd-preview-runtime';assets=repo/'docs/assets/hcd-custom-marks-2026-10-26';configs=[json.loads(Path(name).read_text()) for name in sys.argv[1:]];assert configs
 secrets=[config[key].encode() for config in configs for key in ['alice','bob','reader','secret']];counts={'blobs':0,'expandedEntries':0,'nonLiteralDataUriPlaceholders':0}
 def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
 def scan(data,label,depth=0):
  counts['blobs']+=1;assert depth<9
  assert all(secret not in data for secret in secrets),f'credential in {label}'
  assert not re.search(rb'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}',data),f'JWT in {label}'
  if data.startswith(b'\x1f\x8b'):counts['expandedEntries']+=1;scan(gzip.decompress(data),label+' gzip',depth+1)
  elif data.startswith(b'PK\x03\x04'):
   with zipfile.ZipFile(io.BytesIO(data)) as archive:
    for entry in archive.infolist():
     if entry.is_dir():continue
     counts['expandedEntries']+=1;scan(archive.read(entry),label+'!'+entry.filename,depth+1)
  for match in re.finditer(rb'data:[^;,"\s]+;base64,([A-Za-z0-9+/=]+)',data):
   value=match.group(1)
   try:decoded=base64.b64decode(value+b'='*(-len(value)%4),validate=True)
   except (binascii.Error,ValueError):counts['nonLiteralDataUriPlaceholders']+=1;continue
   counts['expandedEntries']+=1;scan(decoded,label+' data URI',depth+1)
 for source,name in [('custom-marks-frontend.log','frontend.log'),('custom-marks-native-full.log','native-tests.log'),('custom-marks-editor-build.log','editor-build.log'),('custom-marks-native-build.log','native-build.log'),('custom-marks-clippy.log','clippy.log'),('custom-marks-fmt.log','fmt.log'),('custom-marks-diffcheck.log','diffcheck.log')]:shutil.copyfile(runtime/source,assets/name)
 assert 'ℹ pass 638' in (assets/'frontend.log').read_text() and 'ℹ fail 0' in (assets/'frontend.log').read_text();native=(assets/'native-tests.log').read_text();assert '84 passed; 0 failed' in native and '160 passed; 0 failed' in native
 assert not (assets/'fmt.log').read_bytes() and not (assets/'diffcheck.log').read_bytes()
 for name,marker in [('editor-build.log','✓ built'),('native-build.log','Finished'),('clippy.log','Finished')]:assert marker in (assets/name).read_text()
 active=configs[0];head=json.loads((Path(active['root'])/'mentions-docx.hcd/manifest.json').read_text());assert head['revision']==10 and head['capabilities']['customMarks']==1
 assert json.loads((assets/'model-fence.json').read_text())['nativeBytesUnchanged'];assert json.loads((assets/'file-evidence.json').read_text())['futureModelRejectedWithoutMutation']
 package=json.loads((assets/'package-evidence.json').read_text());assert package['consumerExitCode']==0
 friendly=json.loads((assets/'reader-unavailable-dom-r10.json').read_text());assert friendly and all(value['contentEditable']=='false' and value['readOnly']=='true' and 'example.' not in value['title'] for value in friendly)
 for path in sorted(assets.rglob('*')):
  if path.is_file() and path.name!='validation.json':scan(path.read_bytes(),str(path.relative_to(repo)))
 matches=[path for root in runtime.glob('custom-marks-package-*') for path in root.glob('*.tgz') if sha(path)==package['packageSha256']];assert matches
 scan(matches[0].read_bytes(),'private actual npm package')
 core=['custom_marks.rs','structure.rs','bundle.rs','types.rs','lib.rs','validate.rs','export_capabilities.rs'];native_files=['hdoc_server.rs','hdoc_remote.rs','hdoc_collaboration.rs'];editor_files=['customMarks.ts','customMarkTypes.ts','customMarks.test.ts','schema.ts','semanticInlineContent.ts','extensionTypes.ts','extensionRegistry.ts','extensionHistory.ts','collaborationProtocol.ts','protocolClient.test.ts','roomProtocolGuard.ts','App.tsx','NodeExtensions.tsx','api.ts','exportCapabilities.ts','ExportControl.tsx','ExportCompatibility.tsx','i18n.tsx','style.css','public.d.ts']
 paths=[f'crates/hcd-core/src/{name}' for name in core]+[f'crates/officecli/src/{name}' for name in native_files]+[f'examples/hdoc/editor/src/{name}' for name in editor_files]+[f'examples/hdoc/editor/src/commands/{name}.ts' for name in ['blocks','builtins','types','registry']]+['crates/hcd-core/schemas/hcd-2.schema.json','crates/hcd-core/schemas/hcd-patch-4.schema.json','examples/hdoc/editor/sidecar.ts','examples/hdoc/editor/package.json','examples/hdoc/editor/fixtures/customMarks.ts','scripts/hcd-mention-preview.py']+[f'scripts/hcd-custom-marks{suffix}' for suffix in ['.mts','-files.py','-fence.mts','-persistence.mts','-audit.py']]
 record={'date':datetime.datetime.now(datetime.timezone.utc).isoformat(),'localDate':str(datetime.datetime.now(ZoneInfo('Asia/Shanghai')).date()),'scope':'Custom text-format marks, public registry/commands, permanent collaboration, codec/history protection and explicit canonical/offline exports. Full seven-stage goal active; management and reminder delivery deferred.','checks':{'frontend':{'pass':638,'fail':0,'exitCode':0},'newFrontendCases':10,'native':{'hcdCore':84,'officecli':160,'fail':0,'exitCode':0},'newNativeCases':3,'typeScriptStandaloneEmbedBuild':0,'nativeBuild':0,'clippySelectedAllTargetsDenyWarnings':0,'cargoFmtCheck':0,'gitDiffCheck':0,'packedStrictConsumer':0,'actualSocketOfflineMergeOwnUndoRedo':[2,3,4,5,6],'actualBrowserToggleSave':[7,8],'actualBrowserUnavailableHistoryGuardCancelReload':8,'actualBrowserOwnUndoRedo':[9,10],'nativePersistedFreshCodecFreeDoc':[6,10],'signedReceiptCanonicalDigestMatch':True,'canonicalEqualities':[[4,6],[7,9],[8,10]],'firstNativeCheckpoints':{'count':9,'all200':True},'oldWire6RejectedBeforeSync':True,'httpModelAcknowledgementFences':6,'malformedActualSocketRejectedBeforeApplication':True,'nativeBytesAndHeadUnchangedByFences':True,'futureManifest2RejectedWithoutMutation':True,'sourceFreeArchiveExactRevisions':list(range(1,11)),'actualStaticFormats':['docx','pptx','pdf','md'],'actualBrowserDownloads':['docx','html'],'browserDocxStyles':['bold','underline','textColor #246a4b','background #fff2a8'],'browserHtmlEmbeddedImageBytesAndMarkValuesExact':True,'inspectionHtml':'Relative unpacked HCD assets; no original source/codec. Not a single portable file by itself.','pdfWholePageInspection':{'pages':1,'status':'passed'},'noCodecBrowserReopen':10,'localizedExportAndFriendlyMarkLabels':True,'headAfterVerification':10,'credentialZipGzipLiteralDataUriAndPackageScan':{'status':'passed',**counts}},'reactReview':{'status':'passed','checks':['Registry follows session/nodes/marks and releases host subscriptions','Live authority/codec checks; no cached stale registration decisions','Protected text checked before body transactions and own history changes','Ephemeral decorations; no new product global listeners','Command state derives from current editor selection','Export status uses locale keys; unknown provider codes are omitted']},'protocols':{'wire':7,'customMarks':1,'structure':3,'coordinator':4,'nodeEnvelope':2,'mention':1},'nativeBinarySha256':sha(repo/'target/debug/officecli'),'limits':['Immutable format values; same-type formatting uses normal Yjs convergence without per-field mark candidates','Editable inline containers, mark property/migration, native HTML semantic reimport and complex clipboard/Office round trips remain open','Formatting splits/annotation anchors, compound trees, legacy lost data, capacity/compaction/GC and all remaining original requirements continue','No service restart, database/multi-instance, real Office/provider, complete IME/device or production acceptance','Personal history tested before later UI refresh; history persistence across refresh not claimed','Unused head1 pre-lint preview intentionally stopped; final validation fixture never restarted'],'sourceHashes':{name:sha(repo/name) for name in paths},'artifactHashes':{str(path.relative_to(assets)):sha(path) for path in sorted(assets.rglob('*')) if path.is_file() and path.name!='validation.json'}}
 report=assets/'validation.json';report.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n');scan(report.read_bytes(),'validation.json')
 doc=repo/'docs/design/hcd-custom-text-marks.zh.md'
 for href in re.findall(r'\]\(([^)]+)\)',doc.read_text()):
  if '://' not in href:assert (doc.parent/href.split('#')[0]).exists(),href
 print('PASS credential/archive/literal data-URI/package scan:',counts);print('PASS evidence links, head10 and source/artifact hashes; native',record['nativeBinarySha256']);print('Full goal active; no commit/push/publication.')

if __name__=='__main__':main()
