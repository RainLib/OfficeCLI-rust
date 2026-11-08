#!/usr/bin/env python3
"""Read back the owned mixed Word header bindings and exported files."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    root = args.root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('word-region-preview-')
    config = json.loads((root / 'private.json').read_text())
    base = f"http://127.0.0.1:{config['ports'][0]}/v1/documents/region-ui"
    def get(path):
        headers = {'Authorization': 'Bearer ' + config['tokens']['reader'], 'X-HCD-Flow-Layout-Version': '2'}
        with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=60) as response:
            return response.read(), response.headers.get('x-hcd-fidelity-level')
    assert json.loads(get('')[0])['revision'] == 1
    layout = json.loads(get('/word/layout?revision=1')[0])
    first, second = layout['layout']['sections']
    assert 'default' not in second['headers'] and second['headers']['first'] == first['headers']['default']
    assert first['headers']['first'] != first['headers']['default']
    data, fidelity = get('/export/docx?revision=1')
    assert fidelity == 'SEMANTIC'
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        doc = ET.fromstring(archive.read('word/document.xml'))
        sections = doc.findall('.//w:sectPr', ns)
        assert len(sections) == 2
        def refs(section):
            return {ref.attrib['{' + ns['w'] + '}type']: ref.attrib['{' + ns['r'] + '}id'] for ref in section.findall('w:headerReference', ns)}
        one, two = map(refs, sections)
        assert two['first'] == one['default'] and 'default' not in two and one['first'] != one['default']
        assert 'Body one' in ''.join(doc.itertext())
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'mixed-r1.docx').write_bytes(data)
    hcdz, _ = get('/export/hcdz?revision=1')
    (args.output / 'mixed-r1.hcdz').write_bytes(hcdz)
    with tempfile.TemporaryDirectory(prefix='hcd-word-mixed-') as directory:
        unpacked = Path(directory) / 'unpacked.hcd'
        for op in [['unpack', str(args.output / 'mixed-r1.hcdz'), '--output', str(unpacked)], ['validate', str(unpacked)]]:
            subprocess.run([str(repo / 'target/debug/officecli'), 'hdoc', *op, '--json'], capture_output=True, check=True, timeout=60)
        for file in unpacked.rglob('*'):
            if file.is_file():
                assert file.read_bytes() == (root / 'region-ui.hcd' / file.relative_to(unpacked)).read_bytes()
    assert json.loads(get('')[0])['revision'] == 1
    result = {'revision': 1, 'defaultInherited': True, 'firstExplicitSameStory': True,
              'docxFidelity': fidelity, 'docxSha256': hashlib.sha256(data).hexdigest(),
              'offlineHistoryAndResources': 'verified exact'}
    (args.output / 'native-readback.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
