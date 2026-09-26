# XLSX 普通公式编辑验收

`hcd-patch/20` 只修改一个已有的普通公式格。导入时保留公式表达式，Univer 在单元格内编辑并计算，HCD revision 保存表达式；源文件导出写回原生 `<f>`，清空旧缓存，并要求打开工作簿时重新计算。共享公式和数组公式维持只读，避免将公式组误写成孤立公式。无源语义 XLSX 导出仍会把公式扁平化为文本。

## 真实工作簿和命令

`assets/showcase/product-catalog.xlsx` 的 Laptops!E4 为普通公式 `=D4*0.85`，E5 是另一公式。以下命令将 E4 改为 `=D4*0.8`：

```bash
cargo fmt -- --check
cargo test -p hcd-core -p hcd-formats
cargo clippy -p hcd-core -p hcd-formats -p officecli --all-targets -- -D warnings
(cd examples/hdoc/editor && npm run build)
cargo build -p officecli
mkdir -p /tmp/hcd-formula-accept
target/debug/officecli hdoc import assets/showcase/product-catalog.xlsx \
  --output /tmp/hcd-formula-accept/accept-xlsx.hcd --document-id accept-xlsx
python3 - <<'PY'
import gzip, json, subprocess
from pathlib import Path
root = Path('/tmp/hcd-formula-accept')
bundle = root / 'accept-xlsx.hcd'
entries = json.loads(subprocess.check_output([
    'target/debug/officecli', 'hdoc', 'extract-text', str(bundle), '--json', '--limit', '1000'
]))['data']['entries']
node = next(e for e in entries if e['source']['part'] == 'xl/worksheets/sheet1.xml'
            and e['source']['paragraphId'] == 'E4')
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(name):
    with gzip.open(bundle / name, 'rt') as stream:
        return json.load(stream)
chunks = [chunk for page in read(manifest['indexRootHref'])['children']
          for chunk in read(page)['chunks']]
sheet_id = next(chunk['grid']['sheetId'] for chunk in chunks
                if chunk.get('grid', {}).get('sheetName') == 'Laptops'
                and chunk['grid']['kind'] == 'cells')
patch = {'schemaVersion': 'hcd-patch/20', 'documentId': 'accept-xlsx',
         'patchId': 'edit-laptops-e4', 'baseRevision': 0,
         'operations': [{'op': 'xlsx.formula.set', 'nodeId': node['nodeId'],
                         'sheetId': sheet_id, 'formula': '=D4*0.8',
                         'precondition': {'nodeHash': node['nodeHash']}}]}
(root / 'formula.patch.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-formula-accept/accept-xlsx.hcd \
  --patch /tmp/hcd-formula-accept/formula.patch.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-formula-accept/accept-xlsx.hcd
target/debug/officecli hdoc export /tmp/hcd-formula-accept/accept-xlsx.hcd \
  --source assets/showcase/product-catalog.xlsx \
  --output /tmp/hcd-formula-accept/edited.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
original = load_workbook('assets/showcase/product-catalog.xlsx')
edited = load_workbook('/tmp/hcd-formula-accept/edited.xlsx')
assert original['Laptops']['E4'].value == '=D4*0.85'
assert edited['Laptops']['E4'].value == '=D4*0.8'
assert edited['Laptops']['E5'].value == original['Laptops']['E5'].value
assert edited.calculation.fullCalcOnLoad and edited.calculation.forceFullCalc
print('ordinary formula, other formulas, and recalculation settings verified')
PY
```

## 浏览器

把同一个工作簿导入服务根目录，文档 ID 设为 `accept-xlsx`。在参考编辑器打开 Laptops 工作表，双击 E4，把 `=D4*0.85` 改成 `=D4*0.8` 并按 Enter。页面显示 r1、已保存，E4 的计算值变为 1039.2；重新打开后仍能在原格编辑。浏览器生成的修订再次经源文件导出验证，E4 是 `=D4*0.8`，E5 仍为 `=D5*0.85`。

编辑中截图：[单元格内公式](../screenshots/hcd-xlsx-formula-editing.png)。保存后截图：[r1 和更新后的计算结果](../screenshots/hcd-xlsx-formula-edited.png)。

`budget-tracker.xlsx` 的 G8 是共享公式组主单元格。对它提交同样操作会得到只读拒绝，且不生成 revision。公式组的整体编辑和成员重算另需独立实现。
