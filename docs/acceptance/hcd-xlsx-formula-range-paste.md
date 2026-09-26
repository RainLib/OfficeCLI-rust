# XLSX 公式范围粘贴验收

`hcd-patch/22` 在同一个 revision 内保存最多 10000 个 XLSX 单元格改动，可混合已有文字、新建文字、已有公式和新建公式。单个已有节点或空白地址在一批中只能出现一次；任何目标不满足前置条件时，head 不推进。公式仍按 `hcd-patch/20` 和 `/21` 的原生 XLSX 导出规则写入。整批新增内容上限为 2 MiB。

## 真实工作簿与命令

使用 `assets/showcase/product-catalog.xlsx` 的 Laptops 工作表：修改 B4 和 E4，同时在 H4、I4 新建互相引用的公式。

```bash
cargo fmt -- --check
cargo test -p hcd-core -p hcd-formats
cargo clippy -p hcd-core -p hcd-formats -p officecli --all-targets -- -D warnings
(cd examples/hdoc/editor && npm run build)
cargo build -p officecli
mkdir -p /tmp/hcd-formula-range-accept
target/debug/officecli hdoc import assets/showcase/product-catalog.xlsx \
  --output /tmp/hcd-formula-range-accept/product.hcd \
  --document-id formula-range-product
python3 - <<'PY'
import gzip, json, subprocess
from pathlib import Path
root = Path('/tmp/hcd-formula-range-accept')
bundle = root / 'product.hcd'
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(path):
    raw = (bundle / path).read_bytes()
    return json.loads(gzip.decompress(raw) if path.endswith('.gz') else raw)
sheet = next(chunk['grid']['sheetId']
    for child in read(manifest['indexRootHref'])['children']
    for chunk in read(child)['chunks']
    if chunk.get('grid', {}).get('sheetName') == 'Laptops'
    and chunk['grid']['kind'] == 'cells')
entries = json.loads(subprocess.check_output([
    'target/debug/officecli', 'hdoc', 'extract-text', str(bundle),
    '--json', '--limit', '1000']))['data']['entries']
def cell(ref):
    return next(entry for entry in entries
        if entry['source']['part'] == 'xl/worksheets/sheet1.xml'
        and entry['source']['paragraphId'] == ref)
name, price = cell('B4'), cell('E4')
patch = {'schemaVersion': 'hcd-patch/22', 'documentId': 'formula-range-product',
         'patchId': 'mixed-laptops-range', 'baseRevision': 0,
         'operations': [
           {'op': 'text.splice', 'nodeId': name['nodeId'], 'start': 0,
            'deleteCount': len(name['text']), 'insertText': 'Pro Batch',
            'precondition': {'nodeHash': name['nodeHash']}},
           {'op': 'xlsx.formula.set', 'nodeId': price['nodeId'],
            'sheetId': sheet, 'formula': '=D4*0.8',
            'precondition': {'nodeHash': price['nodeHash']}},
           {'op': 'xlsx.formula.create', 'sheetId': sheet, 'row': 4,
            'column': 8, 'formula': '=D4*2'},
           {'op': 'xlsx.formula.create', 'sheetId': sheet, 'row': 4,
            'column': 9, 'formula': '=H4+1'}]}
(root / 'range.patch.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-formula-range-accept/product.hcd \
  --patch /tmp/hcd-formula-range-accept/range.patch.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-formula-range-accept/product.hcd
target/debug/officecli hdoc export /tmp/hcd-formula-range-accept/product.hcd \
  --source assets/showcase/product-catalog.xlsx \
  --output /tmp/hcd-formula-range-accept/edited.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
workbook = load_workbook('/tmp/hcd-formula-range-accept/edited.xlsx')
sheet = workbook['Laptops']
assert [sheet[ref].value for ref in ('B4', 'E4', 'H4', 'I4')] == [
    'Pro Batch', '=D4*0.8', '=D4*2', '=H4+1']
assert workbook.calculation.fullCalcOnLoad and workbook.calculation.forceFullCalc
print('atomic mixed range and native formulas verified')
PY
```

## 浏览器结果

将工作簿导入本地验收根目录为 `accept-xlsx`，源文件放在 `sources/accept-xlsx.xlsx`。在 Laptops!H4 使用系统剪贴板粘贴 `=D4*2<TAB>=H4+1`，网络请求只有一个 `hcd-patch/22`，保存为 r1，显示 `2598` 和 `2599`。[两公式粘贴截图](../screenshots/hcd-xlsx-formula-range-paste.png)。

随后从 B4 粘贴 `Pro Batch<TAB>Spec Batch<TAB>1299<TAB>=D4*0.8<TAB>45<TAB>5<TAB>=D4*3<TAB>=H4+2`。一个 `hcd-patch/22` 包含两项文字修改、三项公式修改，保存为 r2。重新打开后，E4/H4/I4 显示 `1039.2/3897/3899`；[混合范围截图](../screenshots/hcd-xlsx-formula-range-mixed.png)。通过“准备下载 → 下载文件”取得的 `accept-xlsx-r2.xlsx` 经 openpyxl 验证，B4/C4 与 E4/H4/I4 均与编辑结果一致，公式是原生公式。

仍不支持数组公式和无源语义导出的公式保留；图表缓存不会即时重绘。
