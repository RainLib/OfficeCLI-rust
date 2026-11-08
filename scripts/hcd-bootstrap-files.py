#!/usr/bin/env python3
"""Read back the named CUA bootstrap-recovery fixture; never changes its head."""
import argparse, hashlib, json, subprocess, tempfile, zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--browser-root', type=Path, required=True)
browser = parser.parse_args().browser_root.resolve()
assert browser.name.startswith('hcd-mention-preview-')
repo = Path(__file__).resolve().parents[1]
cli = repo / 'target/debug/officecli'
bundle, source = browser / 'mentions-docx.hcd', browser / 'sources/mentions-docx.docx'
root = Path(tempfile.mkdtemp(prefix='hcd-bootstrap-readback-'))

def data(*args):
    return json.loads(subprocess.check_output([str(cli), *map(str, args), '--json'], text=True, timeout=180))['data']
def parts(content):
    return content.get('inlines', []) + [part for child in content.get('children', []) for part in parts(child)]
def text(state):
    return ''.join(part['text'] for block in state['blocks'] for part in parts(block['content']))
def tree(value):
    content = value.get('content', value)
    return [content['kind'], content.get('level'), content.get('listStart'), ''.join(part['text'] for part in content.get('inlines', [])), [tree(child) for child in content.get('children', [])]]
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

head = json.loads((bundle / 'manifest.json').read_text())['revision']
assert head == 4, head
before = digest(bundle / 'manifest.json')
state, initial = data('hdoc', 'editor-state', bundle, '--revision', head), data('hdoc', 'editor-state', bundle, '--revision', 1)
labels = ['本机恢复验证', '离线二次验证', 'Bob 恢复后保留']
assert all(text(state).count(label) == 1 and label not in text(initial) for label in labels)
ids = lambda value: {part['nodeId'] for block in value['blocks'] for part in parts(block['content']) if part.get('nodeId')}
assert ids(state) == ids(initial)
assert not data('hdoc', 'get-revision', bundle, head).get('structuralChange', False)
output, fidelity = root / 'recovered.docx', root / 'fidelity.json'
data('hdoc', 'export', bundle, '--source', source, '--revision', head, '--output', output, '--fidelity-report', fidelity)
assert json.loads(fidelity.read_text())['level'] == 'HIGH'
replacements = [('续段 Continuation', '续段 Continuation 本机恢复验证'), ('收尾 Tail', '收尾 Tail 离线二次验证'), ('正文 After', '正文 After · Bob 恢复后保留')]
with zipfile.ZipFile(source) as original, zipfile.ZipFile(output) as exported:
    assert original.namelist() == exported.namelist()
    for name in original.namelist():
        expected = original.read(name)
        if name == 'word/document.xml':
            for left, right in replacements:
                expected = expected.replace(left.encode(), right.encode())
        assert exported.read(name) == expected, name
reopened = root / 'reopened.hcd'
data('hdoc', 'import', output, '--output', reopened, '--document-id', 'recovered')
assert [tree(block) for block in data('hdoc', 'editor-state', reopened)['blocks']] == [tree(block) for block in state['blocks']]
assert before == digest(bundle / 'manifest.json')
report = {'boundary': 'actual CUA local-draft review and restore followed by native CLI/version/source DOCX/reimport verification; no browser-process crash, OS restart or production acceptance', 'fixtureRoot': str(root), 'browserRoot': str(browser), 'savedRevision': head, 'allMarkersExactlyOnce': True, 'sourceNodeIdsUnchanged': True, 'noStructuralRewrite': True, 'historicalRevision1Unchanged': True, 'sourceBackedFidelity': 'HIGH', 'onlyThreeIntendedTextChanges': True, 'allOtherPartsAndBreakElementsUnchanged': True, 'reimportedTreeStartsBreaksAndTextEqualSaved': True, 'canonicalManifestUnchangedByVerification': True, 'sourceDocxSha256': digest(output)}
(repo / 'docs/assets/hcd-workbench-2026-10-24/bootstrap-file-evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False))
