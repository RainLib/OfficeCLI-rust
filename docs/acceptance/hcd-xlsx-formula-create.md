# XLSX 空白格新增公式验收

`hcd-patch/21` 在空白格创建一个公式节点。Univer 原位输入后保存 HCD revision，重新打开显示计算值；源文件导出保留 XLSX 原生 `<f>` 并要求工作簿重算。已有公式继续使用 `hcd-patch/20` 修改。单次操作限一个公式；粘贴多个公式和数组公式仍不在此批次范围内。

## 可复现命令

```bash
cargo fmt -- --check
cargo test -p hcd-core -p hcd-formats
cargo clippy -p hcd-core -p hcd-formats -p officecli --all-targets -- -D warnings
(cd examples/hdoc/editor && npm run build)
cargo build -p officecli
mkdir -p /tmp/hcd-formula-create-accept
target/debug/officecli hdoc import assets/showcase/product-catalog.xlsx \
  --output /tmp/hcd-formula-create-accept/product.hcd \
  --document-id formula-create-product
python3 - <<'PY'
import gzip, json
from pathlib import Path
root = Path('/tmp/hcd-formula-create-accept')
bundle = root / 'product.hcd'
manifest = json.loads((bundle / 'manifest.json').read_text())
def read(path):
    blob = (bundle / path).read_bytes()
    return json.loads(gzip.decompress(blob) if path.endswith('.gz') else blob)
sheet = next(chunk['grid']['sheetId']
    for child in read(manifest['indexRootHref'])['children']
    for chunk in read(child)['chunks']
    if chunk.get('grid', {}).get('sheetName') == 'Laptops'
    and chunk['grid']['kind'] == 'cells')
patch = {'schemaVersion': 'hcd-patch/21',
         'documentId': 'formula-create-product',
         'patchId': 'create-laptops-h4', 'baseRevision': 0,
         'operations': [{'op': 'xlsx.formula.create', 'sheetId': sheet,
                         'row': 4, 'column': 8, 'formula': '=D4*2'}]}
(root / 'create.patch.json').write_text(json.dumps(patch))
PY
target/debug/officecli hdoc apply /tmp/hcd-formula-create-accept/product.hcd \
  --patch /tmp/hcd-formula-create-accept/create.patch.json --expected-revision 0
target/debug/officecli hdoc validate /tmp/hcd-formula-create-accept/product.hcd
target/debug/officecli hdoc export /tmp/hcd-formula-create-accept/product.hcd \
  --source assets/showcase/product-catalog.xlsx \
  --output /tmp/hcd-formula-create-accept/product-edited.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
original = load_workbook('assets/showcase/product-catalog.xlsx')
edited = load_workbook('/tmp/hcd-formula-create-accept/product-edited.xlsx')
assert original['Laptops']['H4'].value is None
assert edited['Laptops']['H4'].value == '=D4*2'
assert edited['Laptops']['E4'].value == original['Laptops']['E4'].value
assert edited.calculation.fullCalcOnLoad and edited.calculation.forceFullCalc
print('native formula, existing formula and workbook recalculation verified')
PY
```

## 浏览器结果

另将同一源文件导入为 `accept-xlsx`，并放在服务根目录的 `sources/accept-xlsx.xlsx`。在参考编辑器的 Laptops 工作表，双击 H4 输入 `=D4*2` 并按 Enter。页面保存到 r1，H4 显示 `2598`；重新打开仍显示 `2598`。通过“准备下载 → 下载文件”取得 `accept-xlsx-r1.xlsx`，用 openpyxl 检查 H4 为 `=D4*2`，E4 原公式不变。重新打开后将 H4 改为 `=D4*3`，保存到 r2，源文件导出检查为 `=D4*3`。截图：[r1 保存并重新打开后的工作表](../screenshots/hcd-xlsx-formula-create.png)。

无源语义导出仍将公式扁平化为文本；图表缓存不会随新公式即时重绘。
