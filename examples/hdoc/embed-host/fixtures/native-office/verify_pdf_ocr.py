from pathlib import Path
from tempfile import mkdtemp
from uuid import uuid4
import hashlib
import json
import subprocess
import sys
import os
import shutil

from PIL import Image, ImageChops
from pypdf import PdfReader
from xml.etree import ElementTree

root = Path(sys.argv[1])
engine = Path(sys.argv[2])
acceptance = root / 'browser-verification.json'
if not acceptance.exists():
    acceptance = root / 'browser-debug.json'
patches = json.loads(acceptance.read_text())['patches']
work = Path(mkdtemp(prefix='verification-', dir=root))
source = root / 'workshop-scan.pdf'
baseline_hash = hashlib.sha256(source.read_bytes()).hexdigest()

def run(*args, allow_failure=False):
    command = subprocess.run([engine, *map(str, args)], text=True, capture_output=True)
    if allow_failure:
        return command
    assert command.returncode == 0, (args, command.stdout, command.stderr)
    return json.loads(command.stdout)['data'] if '--json' in args else command.stdout

def bundle_at(infile, name):
    bundle = work / f'{name}.hcd'
    run('hdoc', 'import', infile, '-o', bundle, '--document-id', name, '--pdf-raster-mode', 'lossless')
    return bundle

def apply(bundle, payload, rev, allow_failure=False):
    manifest = json.loads((bundle / 'manifest.json').read_text())
    patch = {**payload, 'patchId': str(uuid4()), 'baseRevision': rev, 'documentId': manifest['documentId']}
    path = work / 'patch.json'
    path.write_text(json.dumps(patch, ensure_ascii=False))
    return run('hdoc', 'apply', bundle, '--patch', path, '--expected-revision', rev, '--json', allow_failure=allow_failure)

def entries(bundle):
    return run('hdoc', 'extract-text', bundle, '--json')['entries']

def correct(bundle, before, after, rev, kind):
    node, = [e for e in entries(bundle) if e['text'] == before and e['source']['nodeKind'] == kind]
    return apply(bundle, {'schemaVersion': 'hcd-patch/1', 'operations': [{'op': 'text.splice',
        'nodeId': node['nodeId'], 'start': 0, 'deleteCount': len(before), 'insertText': after,
        'precondition': {'nodeHash': node['nodeHash']}}]}, rev)['revision']

def export(bundle, name, *options):
    path = work / f'{name}.pdf'
    run('hdoc','export',bundle,'-o',path,'--fidelity-report',work / f'{name}-fidelity.json',*options)
    return path

def text(path):
    return [p.extract_text().strip() for p in PdfReader(path).pages]

def compare_pages(expected, actual, label):
    for index, path in enumerate((expected, actual)):
        subprocess.run(['pdftoppm','-r','96','-cropbox','-png',path,work/f'{label}-{index}'],check=True)
    pairs = list(zip(sorted(work.glob(f'{label}-0-*.png')), sorted(work.glob(f'{label}-1-*.png')), strict=True))
    assert pairs
    sizes=[]
    for left, right in pairs:
        with Image.open(left) as a, Image.open(right) as b:
            assert a.size == b.size, (label,a.size,b.size)
            assert ImageChops.difference(a.convert('RGB'),b.convert('RGB')).getbbox() is None, label
            sizes.append(a.size)
    return sizes

bundle = bundle_at(source, 'ocr-native-independent')
recognized = [record['payload'] for record in patches if record['code'] == 200 and record['payload']['schemaVersion'] == 'hcd-patch/62']
assert [patch['operations'][0]['pages'][0]['page'] for patch in recognized] == [1,3,2]
revision = 0
for patch in recognized:
    revision = apply(bundle, patch, revision)['revision']
revision = correct(bundle, 'Release Review Checklist', 'Release Review Approved', revision, 'pdf-ocr')
current_title, = [e['text'] for e in entries(bundle) if e['source']['part']=='pdf/pages/3' and e['text'].startswith('第二场')]
if current_title != '第二场培训安排':
    revision = correct(bundle, current_title, '第二场培训安排', revision, 'pdf-ocr')
refused = apply(bundle, recognized[0], revision, allow_failure=True)
assert refused.returncode, refused.stdout
assert 'already' in (refused.stderr+refused.stdout).lower(), refused.stderr+refused.stdout
source_native = export(bundle,'source-preserved','--source',source)
portable_before = export(bundle,'portable-baseline','--revision',0)
archive = work / 'portable.hcd'
run('hdoc','pack',bundle,'-o',archive)
rebuilt = work / 'unpacked.hcd'
run('hdoc','unpack',archive,'-o',rebuilt)
run('hdoc','validate',rebuilt)
portable_pdf = export(rebuilt,'portable-ocr')
portable_range = export(rebuilt,'portable-page-three','--pdf-pages',3)
source_range = export(rebuilt,'source-page-three','--source',source,'--pdf-pages',3)

native_text = text(source_native)
assert len(native_text)==3 and 'Release Review Approved' in native_text[0] and 'Release Review Checklist' not in native_text[0]
assert native_text[1].count('Native header read once')==1 and 'Training agenda' in native_text[1]
assert '第二场培训安排' in native_text[2] and 'Rotated scan document' in native_text[2]
portable_text = text(portable_pdf)
assert 'Release Review Approved' in portable_text[0] and 'Training agenda' in portable_text[1] and '第二场培训安排' in portable_text[2]
assert len(text(portable_range)) == len(text(source_range)) == 1
assert '第二场培训安排' in text(portable_range)[0] and '第二场培训安排' in text(source_range)[0]
assert 'Release Review' not in text(portable_range)[0]

source_reader = PdfReader(source)
native_reader = PdfReader(source_native)
for index, (original, output) in enumerate(zip(source_reader.pages, native_reader.pages, strict=True)):
    assert original.rotation == output.rotation, index
    assert list(original.cropbox) == list(output.cropbox), index
    before = original.get_contents().get_data().strip()
    after = output.get_contents().get_data()
    assert before in after and b'3 Tr' in after, index
native_pixels = compare_pages(source,source_native,'native-pixels')
portable_pixels = compare_pages(portable_before,portable_pdf,'portable-pixels')

pdftotext = os.environ.get('HCD_PDFTOTEXT') or shutil.which('pdftotext')
assert pdftotext, 'Install Poppler or set HCD_PDFTOTEXT'
layout = subprocess.check_output([pdftotext,'-bbox-layout','-cropbox',source_native,'-'])
page_elements = ElementTree.fromstring(layout).findall('.//{*}page')
for number, phrase, target in [(0,'Release Review Approved','Release Review Checklist'),(2,'Rotated scan document','Rotated scan document')]:
    page = page_elements[number]
    words = [word for word in page.iter() if word.tag.endswith('}word')]
    phrase_words = phrase.split()
    start, = [i for i in range(len(words)) if [word.text for word in words[i:i+len(phrase_words)]] == phrase_words]
    word = words[start]
    physical = [patch['operations'][0]['pages'][0] for patch in recognized if patch['operations'][0]['pages'][0]['page']==number+1][0]
    bounds = [line['bounds'] for line in physical['lines'] if line['text']==target][0]
    assert abs(float(word.attrib['xMin'])/float(page.attrib['width']) - bounds['left']) < 0.04, (word.attrib, page.attrib, bounds)
    assert abs(float(word.attrib['yMin'])/float(page.attrib['height']) - bounds['top']) < 0.05, (word.attrib, page.attrib, bounds)

reimported = bundle_at(source_native, 'ocr-reimported')
assert any(e['text']=='Release Review Approved' and e['source']['nodeKind']=='pdf-source-ocr' for e in entries(reimported))
assert any(e['text']=='第二场培训安排' and e['source']['nodeKind']=='pdf-source-ocr' for e in entries(reimported))
reimported_visual = export(reimported, 'portable-after-pdf-reimport')
assert 'Release Review Approved' in text(reimported_visual)[0]
assert correct(reimported, 'Release Review Approved', 'Release Review Accepted', 0, 'pdf-source-ocr') == 1
reimported_native = export(reimported, 'corrected-reimport', '--source', source_native)
assert 'Release Review Accepted' in text(reimported_native)[0] and 'Release Review Approved' not in text(reimported_native)[0]
compare_pages(source,reimported_native,'corrected-reimport-pixels')
restored = run('hdoc','restore',rebuilt,'--revision',0,'--expected-revision',revision,'--json')['revision']
restored_pdf=export(rebuilt,'restored-original','--source',source)
assert restored_pdf.read_bytes()==source.read_bytes()
reapplied = run('hdoc','restore',rebuilt,'--revision',revision,'--expected-revision',restored,'--json')['revision']
assert reapplied>restored
assert text(export(rebuilt,'restored-ocr','--source',source)) == native_text
assert hashlib.sha256(source.read_bytes()).hexdigest()==baseline_hash

browser_pdf = root / 'searchable-workshop.pdf'
if acceptance.name=='browser-verification.json':
    assert text(browser_pdf) == native_text
    compare_pages(source,browser_pdf,'browser-pixels')

results={
    'evidence':'browser OCR measurements replayed through the native CLI',
    'independentPdfReader':'pypdf and Poppler',
    'pixelComparator':'Poppler at 96 DPI, same CropBox, zero differing pixels',
    'nativePixelSizes':native_pixels,
    'portablePixelSizes':portable_pixels,
    'nativeHeaderOccurrences':1,
    'originalContentStreamsIntact':True,
    'originalSourceBytesUnchanged':True,
    'rotatedCropAndOcrGeometryVerified':True,
    'nativePdfReimportedAsSelectableOcr':True,
    'portableArchiveAndPageSubsetSearchable':True,
    'portableReimportedInvisibleLayerPreserved':True,
    'sourceReimportCorrectionPreservedPixels':True,
    'duplicateOcrRejected':True,
    'historyRestoredOriginalAndRecognizedState':True,
    'browserArtifactIndependentlyVerified':acceptance.name=='browser-verification.json',
    'outputDirectory':str(work),
}
(root/'native-verification.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False,indent=2))
