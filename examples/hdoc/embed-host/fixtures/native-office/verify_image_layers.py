from pathlib import Path
from tempfile import mkdtemp
from PIL import Image, ImageChops
from uuid import uuid4
import base64
import hashlib
import json
import re
import subprocess
import sys
import zipfile

root=Path(sys.argv[1])
binary=Path(sys.argv[2])
work=Path(mkdtemp(prefix='native-',dir=root))
states=dict(json.loads((root/'browser-verification.json').read_text())['states'])
original=root/'素材原件.png'
original_hash=hashlib.sha256(original.read_bytes()).hexdigest()

def run(*args):
    result=subprocess.run([binary,*map(str,args)],capture_output=True,text=True)
    assert result.returncode==0,(args,result.stderr,result.stdout)
    return json.loads(result.stdout)['data'] if '--json' in args else result.stdout

def image(name):
    with Image.open(root/name) as data:
        assert data.format=='PNG',(name,data.format)
        result=data.convert('RGBA')
    assert result.size==(768,512),(name,result.size)
    return result

def diff(a,b):
    image_diff=ImageChops.difference(a,b)
    return sum(1 for pixel in image_diff.get_flattened_data() if any(pixel))

def check_identical(a,b):
    assert diff(image(a),image(b))==0,(a,b)

sort_diff=diff(image('before-sort.png'),image('after-sort.png'))
assert sort_diff>10_000,sort_diff
blue=states[8]['imageLayers']['stack']['layers'][1]
with Image.open(root/'蓝色卡片.png') as top:
    reconstructed=image(original)
    reconstructed.alpha_composite(top.convert('RGBA'),dest=(blue['x'],blue['y']))
assert diff(reconstructed,image('hidden-layer.png'))==0
check_identical('working-composite.png','adjustment-hidden.png')
check_identical('adjustment-hidden.png','composite-reopened.png')
check_identical('composite-reopened.png','readback-png.png')
check_identical('before-sort.png','restored-layer-order.png')
assert diff(image('adjustment-layer.png'),image('working-composite.png'))>100_000

layer=states[7]['imageLayers']['stack']['layers'][2]
assert layer['opacity']==56 and layer['width']>312 and layer['height']>196
# A solid point in both cards, away from lettering and transparent borders.
point=(451,296)
under=image('hidden-layer.png').getpixel(point)
assert under[:3]==(115,151,164)
a=(255*layer['opacity']+50)//100
expected=tuple(round((value*a+old*(255-a))/255) for old,value in zip(under[:3],(226,141,112)))
actual=image('after-sort.png').getpixel(point)
assert all(abs(k-v)<=1 for k,v in zip(actual[:3],expected)),(point,under,expected,actual)

with zipfile.ZipFile(root/'editable-layers.hcd') as archive:
    assert archive.testzip() is None
    member_names=archive.namelist()
    for source_layer in states[11]['imageLayers']['stack']['layers']:
        hash_id=source_layer['assetHash']
        entry,=[path for path in member_names if f'/{hash_id}.png' in path]
        assert hashlib.sha256(archive.read(entry)).hexdigest()==hash_id

bundle=work/'reopened.hcd'
run('hdoc','unpack',root/'editable-layers.hcd','-o',bundle)
report=run('hdoc','validate',bundle,'--json')
assert report['valid'],report
manifest=json.loads((bundle/'manifest.json').read_text())
assert manifest['revision']==11 and manifest['source']['sha256']==original_hash
source_revision=run('hdoc','get-chunk',bundle,0,'--revision',0,'--json')
assert 'data-hcd-image-layers' not in source_revision['html']
head=run('hdoc','get-chunk',bundle,0,'--json')['html']
encoded=re.search(r'data-hcd-image-layers="([A-Za-z0-9_-]+)"',head).group(1)
stack=json.loads(base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4)))
assert stack==states[11]['imageLayers']['stack'] and stack['layers'][-1]['visible'] is False
asset_map=states[11]['imageLayers']
# Edit the restored portable graph through the same native revision operation.
stack['layers'][-1]['visible']=True
patch={'schemaVersion':'hcd-patch/63','documentId':manifest['documentId'],'patchId':str(uuid4()),'baseRevision':11,
 'operations':[{'op':'image.layers.set','nodeId':asset_map['nodeId'],'stack':stack,
 'precondition':{'visualHash':asset_map['visualHash']}}]}
patchfile=work/'layer-patch.json'
patchfile.write_text(json.dumps(patch,ensure_ascii=False))
assert run('hdoc','apply',bundle,'--patch',patchfile,'--expected-revision',11,'--json')['revision']==12
composed=work/'re-enabled-adjustment.png'
run('hdoc','export',bundle,'-o',composed)
assert diff(image(composed),image('adjustment-layer.png'))==0
assert run('hdoc','restore',bundle,'--revision',0,'--expected-revision',12,'--json')['revision']==13
restored=work/'original-restored.png'
run('hdoc','export',bundle,'-o',restored)
assert diff(image(restored),image(original))==0
assert hashlib.sha256(original.read_bytes()).hexdigest()==original_hash
results={
 'sameOriginalSha256':original_hash,'originalPngAndReopenVerified':True,
 'reorderChangedPixels':sort_diff,'layerOpacity':layer['opacity'],'actualProbeRGBA':actual,
 'hiddenLayerAndAdjustmentAreReversiblePixelForPixel':True,
 'browserRestoredLayerOrderAndPixels':True,'archiveAssetsAndLayerGraphVerified':True,
 'archivedLayerGraphRemainedEditableAfterUnpack':True,'originalRestoredPixelForPixel':True,
 'directory':str(work),
}
(root/'native-verification.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False,indent=2))
