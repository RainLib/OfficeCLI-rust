#!/usr/bin/env python3
"""Read back an owned PPTX image-recovery browser scenario."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    root = args.root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('hcd-workbook-')
    config = json.loads((root / 'private.json').read_text())
    url = f"http://127.0.0.1:{config['ports'][0]}/v1/documents/book"
    def get(path):
        request = urllib.request.Request(url + path, headers={'Authorization': 'Bearer ' + config['tokens']['reader']})
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    assert json.loads(get(''))['revision'] == 2
    image = json.loads(get('/images'))['entries'][0]
    node = image['nodeId']
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    for revision, width in enumerate([100, 140, 120]):
        found = json.loads(get(f'/images/{node}?revision={revision}'))
        assert found['revision'] == revision and found['image']['geometry']['width'] == width * 12700
        assert found['image']['geometry']['height'] == 50 * 12700
        if revision:
            try:
                get(f'/export/pptx?revision={revision}&source=true')
                raise AssertionError('source export unexpectedly accepted an edited image')
            except urllib.error.HTTPError as error:
                assert error.code == 400 and b'source-backed pptx image rewrite is not implemented' in error.read()
        ppt = get(f'/export/pptx?revision={revision}&source={"true" if revision == 0 else "false"}')
        with zipfile.ZipFile(io.BytesIO(ppt)) as archive:
            xml = ET.fromstring(archive.read('ppt/slides/slide1.xml'))
            ns = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main', 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
            picture = xml.find('.//p:pic', ns)
            extent = picture.find('.//a:xfrm/a:ext', ns)
            assert int(extent.attrib['cx']) == width * 12700 and int(extent.attrib['cy']) == 50 * 12700
            assert 'Original' in ''.join(xml.itertext())
        (args.output / f'picture-r{revision}.pptx').write_bytes(ppt)
        records.append({'revision': revision, 'widthPt': width, 'mode': 'source' if revision == 0 else 'semantic', 'sha256': hashlib.sha256(ppt).hexdigest()})
    hcdz = get('/export/hcdz?revision=2')
    (args.output / 'picture-r2.hcdz').write_bytes(hcdz)
    with tempfile.TemporaryDirectory(prefix='hcd-picture-recovery-') as directory:
        unpacked = Path(directory) / 'unpacked.hcd'
        for operation in [['unpack', str(args.output / 'picture-r2.hcdz'), '--output', str(unpacked)], ['validate', str(unpacked)]]:
            subprocess.run([str(repo / 'target/debug/officecli'), 'hdoc', *operation, '--json'], capture_output=True, check=True, timeout=60)
        for file in unpacked.rglob('*'):
            if file.is_file():
                assert file.read_bytes() == (root / 'book.hcd' / file.relative_to(unpacked)).read_bytes()
    evidence = {'versions': records, 'otherTextRetained': True, 'editedSourceExport': 'explicitly rejected', 'offlineHistoryAndResources': 'verified exact'}
    (args.output / 'native-readback.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
