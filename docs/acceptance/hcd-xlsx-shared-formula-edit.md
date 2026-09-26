# XLSX 共享公式成员编辑验收

工作簿可能把一片连续公式存成一个共享主公式和若干无表达式的成员。导入时，HCD 仅对完整、最多 4096 格、可安全平移 A1 引用的共享组推导每格表达式。编辑某个成员仍提交单格 `hcd-patch/20`；源文件导出把该组展开为独立的原生 `<f>`，其他共享组保持原结构。数组公式、跨表引用、结构化引用和无法完整验证的共享组继续只读。

## 真实工作簿与命令

`assets/showcase/budget-tracker.xlsx` 的 Overview!G8:G14 是共享公式组，G9 原公式为 `=SUM(C9:F9)`，缓存结果为 $375,000。以下命令仅把 G9 改成 `=SUM(C9:E9)`：

```bash
cargo fmt -- --check
cargo test -p hcd-core -p hcd-formats
cargo clippy -p hcd-core -p hcd-formats -p officecli --all-targets -- -D warnings
(cd examples/hdoc/editor && npm run build)
cargo build -p officecli
mkdir -p /tmp/hcd-shared-formula-accept
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-shared-formula-accept/accept-xlsx.hcd \
  --document-id accept-xlsx
python3 - <<'PY'
import gzip, json, subprocess
from pathlib import Path
root = Path('/tmp/hcd-shared-formula-accept')
bundle = root / 'accept-xlsx.hcd'
entries = json.loads(subprocess.check_output([
    'target/debug/officecli', 'hdoc', 'extract-text', str(bundle), '--json', '--limit', '1000'
]))['data']['entries']
node = next(entry for entry in entries if entry['source']['part'] == 'xl/worksheets/sheet1.xml'
            and entry['source']['paragraphId'] == 'G9')
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(name):
    with gzip.open(bundle / name, 'rt') as stream:
        return json.load(stream)
chunks = [chunk for page in read(manifest['indexRootHref'])['children']
          for chunk in read(page)['chunks']]
sheet = next(chunk['grid']['sheetId'] for chunk in chunks
             if chunk.get('grid', {}).get('sheetName') == 'Overview'
             and chunk['grid']['kind'] == 'cells')
patch = {'schemaVersion': 'hcd-patch/20', 'documentId': 'accept-xlsx',
         'patchId': 'edit-shared-g9', 'baseRevision': 0,
         'operations': [{'op': 'xlsx.formula.set', 'nodeId': node['nodeId'],
                         'sheetId': sheet, 'formula': '=SUM(C9:E9)',
                         'precondition': {'nodeHash': node['nodeHash']}}]}
(root / 'shared.patch.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-shared-formula-accept/accept-xlsx.hcd \
  --patch /tmp/hcd-shared-formula-accept/shared.patch.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-shared-formula-accept/accept-xlsx.hcd
target/debug/officecli hdoc export /tmp/hcd-shared-formula-accept/accept-xlsx.hcd \
  --source assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-shared-formula-accept/edited.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
source = load_workbook('assets/showcase/budget-tracker.xlsx')
edited = load_workbook('/tmp/hcd-shared-formula-accept/edited.xlsx')
sheet = edited['Overview']
assert sheet['G8'].value == '=SUM(C8:F8)'
assert sheet['G9'].value == '=SUM(C9:E9)'
assert sheet['G10'].value == '=SUM(C10:F10)'
assert sheet['H9'].value == source['Overview']['H9'].value
assert len(sheet._charts) == len(source['Overview']._charts) == 1
assert edited.calculation.fullCalcOnLoad and edited.calculation.forceFullCalc
print('one edited member, independent native formulas, other group and chart preserved')
PY
```

## 浏览器结果

将同一工作簿导入服务根目录，文档 ID 设为 `accept-usage-xlsx`，把源文件保存为 `sources/accept-usage-xlsx.xlsx`。在参考编辑器打开 Overview，双击 G9，输入 `=SUM(C9:E9)` 并按 Enter。保存后为 r1：G9 显示 $313,000，H9 显示 78%，G15 显示 $2,278,000；刷新后仍保持这些结果。“准备下载 → 下载文件”得到的 XLSX 经 openpyxl 验证，G8、G9、G10、H9 均为原生公式，图表仍在。

截图：[原位编辑](../screenshots/hcd-xlsx-shared-formula-editing.png)、[保存后的计算结果](../screenshots/hcd-xlsx-shared-formula-edited.png)。导入时提供原始数值与数字格式给 Univer，避免保存后把格式化文本当作求和输入，造成公式结果变成 0。重新打开 r1 时，编辑过的公式会在可见分片加载完后重新计算，G9、H9 与总计仍显示新结果，且没有额外产生 revision。

HCD 图表 SVG 和复制的图表缓存不会因单元格公式修改而即时重绘。导出报告会标记 `XLSX_CHART_CACHE_RECALC_REQUIRED`；使用电子表格程序打开并重算后，应再次检查图表。
