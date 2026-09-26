# XLSX 区域粘贴验收

`hcd-patch/19` 将一次粘贴中的空白格首次写入与已有格文本修改保存为同一 HCD revision。单批最多 10000 个操作；重复地址、已有内容被当作空白格覆盖、公式输入和不可编辑格会被拒绝或在浏览器回滚。新节点有稳定 ID，历史修订不变。

## 真实工作簿与命令

使用 `assets/showcase/budget-tracker.xlsx`。`Settings` 表 B1、B2 是空白格，A2 为已有格；`Overview` 含公式和图表。

```bash
cargo fmt -- --check
cargo test -p hcd-core -p hcd-formats
cargo clippy -p hcd-core -p hcd-formats -p officecli --all-targets -- -D warnings
(cd examples/hdoc/editor && npm run build)
cargo build -p officecli
mkdir -p /tmp/hcd-range-paste-accept
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-range-paste-accept/budget.hcd --document-id range-paste-budget
target/debug/officecli hdoc extract-text /tmp/hcd-range-paste-accept/budget.hcd \
  --json --limit 1000 > /tmp/hcd-range-paste-accept/text.json
python3 - <<'PY'
import gzip, json
from pathlib import Path
root = Path('/tmp/hcd-range-paste-accept')
bundle = root / 'budget.hcd'
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(name):
    with gzip.open(bundle / name, 'rt') as source:
        return json.load(source)
chunks = [chunk for page in read(manifest['indexRootHref'])['children']
          for chunk in read(page)['chunks']]
settings = next(chunk for chunk in chunks if chunk.get('grid', {}).get('sheetName') == 'Settings'
                and chunk['grid']['kind'] == 'cells')
entries = json.loads((root / 'text.json').read_text())['data']['entries']
a2 = next(entry for entry in entries if entry['source']['part'] == 'xl/worksheets/sheet3.xml'
          and entry['source']['paragraphId'] == 'A2')
patch = {'schemaVersion': 'hcd-patch/19', 'documentId': 'range-paste-budget',
         'patchId': 'real-settings-paste', 'baseRevision': 0,
         'operations': [
             {'op': 'xlsx.cell.set', 'sheetId': settings['grid']['sheetId'],
              'row': 1, 'column': 2, 'text': 'Note'},
             {'op': 'xlsx.cell.set', 'sheetId': settings['grid']['sheetId'],
              'row': 2, 'column': 2, 'text': 'Reviewed'},
             {'op': 'text.splice', 'nodeId': a2['nodeId'], 'start': 0,
              'deleteCount': len(a2['text']), 'insertText': 'Marketing 2026',
              'precondition': {'nodeHash': a2['nodeHash']}}]}
(root / 'paste.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-range-paste-accept/budget.hcd \
  --patch /tmp/hcd-range-paste-accept/paste.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-range-paste-accept/budget.hcd
target/debug/officecli hdoc export /tmp/hcd-range-paste-accept/budget.hcd \
  --source assets/showcase/budget-tracker.xlsx --revision 1 \
  --output /tmp/hcd-range-paste-accept/edited.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
source = load_workbook('assets/showcase/budget-tracker.xlsx')
edited = load_workbook('/tmp/hcd-range-paste-accept/edited.xlsx')
assert edited.sheetnames == source.sheetnames
assert edited['Settings']['A2'].value == 'Marketing 2026'
assert edited['Settings']['B1'].value == 'Note'
assert edited['Settings']['B2'].value == 'Reviewed'
assert edited['Overview']['G8'].value == source['Overview']['G8'].value
assert len(edited['Overview']._charts) == len(source['Overview']._charts)
print('one revision: mixed range edit, formulas and chart preserved')
PY
```

## 浏览器

导入同一 XLSX 为 `accept-xlsx`，启动 `hdoc serve` 和参考编辑器。打开 Settings，选择 A1，粘贴 `Pasted Header<TAB>Note<NEWLINE>Pasted Dept<TAB>Reviewed`。一次提交生成 r1；再选择 A3 粘贴另一 2×2 区域，生成 r2。编辑后仍保持 Settings 工作表及所选区域，刷新后内容可见。截图：[Settings 区域粘贴后的 r2](../screenshots/hcd-xlsx-range-paste.png)。

`source-backed` 导出保留源工作簿的工作表、公式、图表和样式；无源语义导出包含新文本，但仍会重建并扁平化工作簿。跨分片、历史、重复地址、覆盖已有格和陈旧修订由 `range_paste_creates_cells_across_windows_and_edits_existing_cell_atomically` 测试覆盖。
