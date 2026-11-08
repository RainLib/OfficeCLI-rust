#!/usr/bin/env python3
"""Real HTML hierarchy/source exports and format boundaries, without a model."""
import argparse, hashlib, json, subprocess, tempfile, zipfile
from pathlib import Path
from xml.etree import ElementTree as E

parser = argparse.ArgumentParser()
parser.add_argument('--browser-root', type=Path, help='owned HTML fixture after CUA save r2, own undo r3, redo r4')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
cli = repo / 'target/debug/officecli'
root = Path(tempfile.mkdtemp(prefix='hcd-html-lists-'))
assets = repo / 'docs/assets/hcd-lists-2026-10-24'
assets.mkdir(parents=True, exist_ok=True)

def run(*parts):
    return subprocess.check_output([str(cli), *map(str, parts)], text=True, timeout=180)
def data(*parts):
    return json.loads(run(*parts, '--json'))['data']
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def tree(value):
    content = value.get('content', value)
    return [content['kind'], content.get('level'), content.get('listStart'),
            ''.join(part['text'] for part in content.get('inlines', [])),
            [tree(child) for child in content.get('children', [])]]
def trees(state):
    return [tree(block) for block in state['blocks']]
def parts(content):
    return content.get('inlines', []) + [part for child in content.get('children', []) for part in parts(child)]
def text(state):
    return ''.join(part['text'] for block in state['blocks'] for part in parts(block['content']))

source = root / 'source.html'
source_text = '''<!doctype html><html><head><meta charset="utf-8"><title>Metadata only</title></head><body>
<h1>HTML 列表兼容验收</h1>
<ol start="4"><li><p><strong>父项甲 ParentA</strong></p><p>续段 Continuation<br>第二行 LineTwo</p>
<ol start="7"><li><p><em>子项七 ChildSeven</em></p><ul><li>叶项 Leaf</li></ul></li><li>子项八 ChildEight</li></ol>
<p>收尾 Tail</p></li><li>父项乙 ParentB</li></ol>
<p>正文 After</p><ol start="10"><li>重新编号 Restart</li></ol><ul><li>项目符号 Bullet</li></ul>
</body></html>'''
source.write_text(source_text)
bundle = root / 'html.hcd'
data('hdoc', 'import', source, '--output', bundle, '--document-id', 'html-list-verify')
data('hdoc', 'project-editor', bundle, '--expected-revision', 0)
initial = data('hdoc', 'editor-state', bundle)
initial_tree = trees(initial)
assert [block['content']['kind'] for block in initial['blocks']] == ['heading', 'list_item', 'list_item', 'paragraph', 'list_item', 'list_item']
parent = initial['blocks'][1]['content']
assert len(parent['children']) == 4 and parent['children'][2]['listStart'] == 7
assert parent['children'][2]['children'][0]['children'][1]['kind'] == 'bullet_list'
assert 'Metadata only' not in text(initial)
entries = data('hdoc', 'extract-text', bundle)['entries']
ids = [part['nodeId'] for block in initial['blocks'] for part in parts(block['content']) if part.get('nodeId')]
assert len(ids) == len(set(ids)) and set(ids) == {entry['nodeId'] for entry in entries}
before = digest(bundle / 'manifest.json')
labels = ['ParentA', 'ChildSeven', 'Leaf', 'ChildEight', 'ParentB', 'After', 'Restart', 'Bullet', 'Continuation', 'LineTwo', 'Tail']
exports, reopened, pdf_geometry = [], {}, {}
for fmt in ['html', 'md', 'docx', 'pdf']:
    path = root / f'exported.{fmt}'
    if fmt == 'html':
        data('hdoc', 'render-html', bundle, '--revision', 1, '--output', path)
    else:
        data('hdoc', 'export', bundle, '--revision', 1, '--output', path, '--fidelity-report', root / f'{fmt}-fidelity.json')
    content = path.read_text() if fmt in ['html', 'md'] else run('view', path, 'text')
    for label in labels:
        assert content.count(label) == 1, (fmt, label, content)
    exports.append({'format': fmt, 'route': 'standalone inspection render' if fmt == 'html' else 'semantic export', 'allLabelsExactlyOnce': True, 'sha256': digest(path)})
    if fmt == 'pdf':
        bbox = root / 'pdf-bbox.html'
        subprocess.run(['pdftotext', '-bbox', str(path), str(bbox)], check=True)
        positions = {node.text: float(node.attrib['xMin']) for node in E.parse(bbox).iter()
                     if node.tag.endswith('word') and node.text in ['父项甲', '续段', '第二行', '收尾', '子项七', '子项八', '叶项', '正文']}
        assert len(positions) == 8, positions
        assert all(abs(positions[label] - positions['父项甲']) < .5 for label in ['续段', '第二行', '收尾'])
        assert abs(positions['子项七'] - positions['子项八']) < .5
        assert positions['正文'] + 20 < positions['父项甲'] < positions['子项七'] - 20 < positions['叶项'] - 40
        pdf_geometry = {'reader': 'Poppler pdftotext -bbox', 'wordXMinPoints': positions,
                        'continuationAndTailAlignWithParent': True, 'mixedNestedIndentationRetained': True}
    if fmt != 'pdf':
        target = root / f'reopened-{fmt}.hcd'
        data('hdoc', 'import', path, '--output', target, '--document-id', f'reopened-{fmt}')
        reopened[fmt] = data('hdoc', 'editor-state', target)
        (root / f'reopened-{fmt}-model.json').write_text(json.dumps(reopened[fmt], ensure_ascii=False, indent=2))
assert trees(reopened['html']) == initial_tree
assert trees(reopened['md']) == initial_tree
assert before == digest(bundle / 'manifest.json')

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
ns = {'w': W}
def native_numbering(path):
    with zipfile.ZipFile(path) as package:
        document = E.fromstring(package.read('word/document.xml'))
        result = []
        for paragraph in document.findall('w:body/w:p', ns):
            number = paragraph.find('w:pPr/w:numPr/w:numId', ns)
            if number is None:
                continue
            result.append({'text': ''.join(node.text or '' for node in paragraph.findall('.//w:t', ns)),
                           'numId': number.attrib['{' + W + '}val'],
                           'depth': int(paragraph.find('w:pPr/w:numPr/w:ilvl', ns).attrib['{' + W + '}val'])})
        return result
numbers = native_numbering(root / 'exported.docx')
assert [row['depth'] for row in numbers] == [0, 1, 2, 1, 0, 0, 0]
assert numbers[0]['numId'] == numbers[4]['numId'] and numbers[1]['numId'] == numbers[3]['numId']
via_html_docx = root / 'via-html.docx'
data('hdoc', 'export', root / 'reopened-html.hcd', '--output', via_html_docx)
via_numbers = native_numbering(via_html_docx)
assert via_numbers[0]['numId'] == via_numbers[4]['numId']

# Preserve the actual reader boundary rather than passing text-only checks as
# proof of paragraph ownership in the reimported Word model.
docx_tree = trees(reopened['docx'])
docx_equal = docx_tree == initial_tree
assert docx_equal, 'owned multi-paragraph DOCX must restore the full list tree'
assert text(reopened['docx']) == text(initial), 'DOCX text and hard breaks must survive reimport'
report = {'boundary': 'local real CLI, native DOCX/MD/HTML/PDF files and reimport models; no Office/WPS application or production acceptance',
          'fixtureRoot': str(root), 'sourceSha256': digest(source), 'sourceAnchorIdsUniqueAndPreserved': True,
          'parentParagraphsAndMixedHierarchyRetained': True, 'semanticExportsDoNotChangeCanonicalManifest': True,
          'exports': exports, 'pdfGeometry': pdf_geometry, 'originalTree': initial_tree, 'nativeNumbering': numbers,
          'reimports': {'html': {'hierarchyStartsBreaksAndTextEqual': True, 'tree': trees(reopened['html'])},
                        'markdown': {'hierarchyStartsBreaksAndTextEqual': True, 'tree': trees(reopened['md'])},
                        'docx': {'textRetained': all(text(reopened['docx']).count(label) == 1 for label in labels),
                                 'textAndHardBreaksEqual': True,
                                 'fullTreeEqual': docx_equal,
                                 'gap': None,
                                 'ownershipProtocol': 'urn:officecli:semantic-lists:1; native numbering plus ignorable paragraph ownership',
                                 'tree': docx_tree}},
          'formattingMarksNotIncludedInTreeComparison': True, 'htmlReexportRetainsNativeListSeries': True}

word_bundle = root / 'reopened-docx.hcd'
word_entry = next(entry for entry in data('hdoc', 'extract-text', word_bundle)['entries'] if entry['text'] == '第二行 LineTwo')
word_patch = root / 'word-edit.json'
word_patch.write_text(json.dumps({'schemaVersion': 'hcd-patch/1', 'documentId': 'reopened-docx', 'patchId': 'edit-after-word-break',
    'baseRevision': 0, 'actor': {}, 'metadata': {}, 'operations': [{'op': 'text.splice', 'nodeId': word_entry['nodeId'], 'start': 0,
    'deleteCount': len(word_entry['text']), 'insertText': '第二行 LineTwo updated', 'precondition': {'nodeHash': word_entry['nodeHash']}}]}, ensure_ascii=False))
data('hdoc', 'apply', word_bundle, '--patch', word_patch, '--expected-revision', 0)
word_output = root / 'word-break-source-updated.docx'
data('hdoc', 'export', word_bundle, '--source', root / 'exported.docx', '--revision', 1, '--output', word_output,
     '--fidelity-report', root / 'word-break-fidelity.json')
with zipfile.ZipFile(root / 'exported.docx') as before_word, zipfile.ZipFile(word_output) as after_word:
    assert before_word.namelist() == after_word.namelist()
    for part in before_word.namelist():
        old, new = before_word.read(part), after_word.read(part)
        assert new == (old.replace('第二行 LineTwo'.encode(), '第二行 LineTwo updated'.encode()) if part == 'word/document.xml' else old), part
assert json.loads((root / 'word-break-fidelity.json').read_text())['level'] == 'HIGH'
word_reopened = root / 'word-break-reopened.hcd'
data('hdoc', 'import', word_output, '--output', word_reopened, '--document-id', 'word-break-reopened')
assert text(data('hdoc', 'editor-state', word_reopened)) == text(initial).replace('第二行 LineTwo', '第二行 LineTwo updated')
assert text(data('hdoc', 'editor-state', word_bundle, '--revision', 0)) == text(initial)
report['wordSourceBackedBreakEdit'] = {'fidelity': 'HIGH', 'onlyTargetTextBytesChanged': True,
    'otherPartsAndBreakElementsUnchanged': True, 'reimportedTextAndHardBreaksEqual': True, 'historicalTextAndBreaksUnchanged': True}

entry = next(entry for entry in entries if entry['text'] == '子项七 ChildSeven')
patch = root / 'edit.json'
patch.write_text(json.dumps({'schemaVersion': 'hcd-patch/1', 'documentId': 'html-list-verify', 'patchId': 'html-list-source-edit',
    'baseRevision': 1, 'actor': {}, 'metadata': {}, 'operations': [{'op': 'text.splice', 'nodeId': entry['nodeId'], 'start': 0,
    'deleteCount': len(entry['text']), 'insertText': '子项七 已修改', 'precondition': {'nodeHash': entry['nodeHash']}}]}, ensure_ascii=False))
data('hdoc', 'apply', bundle, '--patch', patch, '--expected-revision', 1)
updated = root / 'source-updated.html'
data('hdoc', 'export', bundle, '--source', source, '--revision', 2, '--output', updated, '--fidelity-report', root / 'source-fidelity.json')
assert updated.read_text() == source_text.replace('子项七 ChildSeven', '子项七 已修改')
assert json.loads((root / 'source-fidelity.json').read_text())['level'] == 'HIGH'
assert trees(data('hdoc', 'editor-state', bundle, '--revision', 1)) == initial_tree
report['sourceBackedEdit'] = {'fidelity': 'HIGH', 'onlyTargetTextBytesChanged': True, 'historicalTreeUnchanged': True}

if args.browser_root:
    browser = args.browser_root.resolve()
    assert browser.name.startswith('hcd-mention-preview-')
    selected = browser / 'mentions-docx.hcd'
    original = browser / 'sources/mentions-docx.html'
    original_text = original.read_text()
    initial_state = data('hdoc', 'editor-state', selected, '--revision', 1)
    original_ids = {part['nodeId'] for block in initial_state['blocks'] for part in parts(block['content']) if part.get('nodeId')}
    head_hash = digest(selected / 'manifest.json')
    saved = []
    for revision, accepted in [(2, True), (3, False), (4, True)]:
        record = data('hdoc', 'get-revision', selected, revision)
        assert not record.get('structuralChange', False)
        state = data('hdoc', 'editor-state', selected, '--revision', revision)
        assert text(state).count('已验证') == int(accepted) and text(state).count('Bob 保留') == 1
        assert {part['nodeId'] for block in state['blocks'] for part in parts(block['content']) if part.get('nodeId')} == original_ids
        output = root / f'browser-r{revision}.html'
        fidelity = root / f'browser-r{revision}-fidelity.json'
        data('hdoc', 'export', selected, '--source', original, '--revision', revision, '--output', output, '--fidelity-report', fidelity)
        expected = original_text.replace('正文 After', '正文 After · Bob 保留')
        if accepted:
            expected = expected.replace('ChildSeven', 'ChildSeven 已验证')
        assert output.read_text() == expected
        assert json.loads(fidelity.read_text())['level'] == 'HIGH'
        target = root / f'browser-r{revision}.hcd'
        data('hdoc', 'import', output, '--output', target, '--document-id', f'browser-html-{revision}')
        assert trees(data('hdoc', 'editor-state', target)) == trees(state)
        saved.append({'revision': revision, 'ownTextAccepted': accepted, 'peerTextRetained': True,
                      'sourceNodeIdsRetained': True, 'noStructuralRewrite': True, 'fidelity': 'HIGH',
                      'onlyIntendedSourceTextChanged': True, 'reimportedTreeEqualSaved': True, 'sha256': digest(output)})
    assert head_hash == digest(selected / 'manifest.json')
    report['browserRoundtrip'] = {'fixtureRoot': str(browser), 'canonicalManifestUnchangedByVerification': True, 'revisions': saved}

(assets / 'html-list-file-evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'status': 'PASS HTML hierarchy/source edits, actual formats and declared reimport boundaries', 'root': str(root)}, ensure_ascii=False))
