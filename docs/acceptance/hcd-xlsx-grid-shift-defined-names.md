# XLSX 行/列移位把 workbook 里的命名区域一起带走

行插删、列插删这四条操作（`hcd-patch/12`/`13`/`14`/`15`）在动包之前先跑一趟检查：源簿里凡是它算不动的东西，整条导出直接拒绝，于是不存在“行移了一半、引用还在原位”的簿子。`xl/workbook.xml` 的 `<definedName>` 以前是这么一条硬边界 —— 只要这张簿里有一条名字指着被移位的表，插一行就导不出来：

```
Error: unsupported mode: XLSX grid shift cannot update a defined name on the edited sheet
```

命名区域是电子表格里最普遍的东西（打印区域、打印标题、下拉列表源、筛选区 `_xlnm._FilterDatabase`），这条边界实际等于“带命名区域的簿子不能插删行/列”。这一片把它改成**只重写会被这趟移位带动的地址**：算得动的跟着走，算不动的还是照老规矩拒绝，只是报错点名那一条名字（`XLSX grid shift cannot update the defined name Total`），不再一锅端整本簿子。没有新增号段：补丁侧一个字没改，`hcd-patch/12`/`13`/`14`/`15` 的形状、边界、`baseRevision` 要求都跟原来一样，改的全在 `crates/hcd-formats/src/xlsx.rs` 的源文件导出路径上。

## 复现

源是 `assets/showcase/product-catalog.xlsx`：LibreOffice 写的，每个元素带 `x:` 前缀，三个页签 `Laptops`、`Accessories`、`Order Form`（名字里有空格，所以引用它的时候必须加引号），整本簿子只有一条命名区域 `_xlnm.Print_Area` = `'Order Form'!$A$1:$D$25`。`Order Form` 的部件里只有 `mergeCells`（移位本来就会跟着走），没有 `dataValidation`、没有窗格，所以这张表是真实簿子里能移的那一张。

```bash
cargo build -p officecli
mkdir -p /tmp/hcd-dn-run
cp assets/showcase/product-catalog.xlsx /tmp/hcd-dn-run/accept-xlsx.xlsx
target/debug/officecli hdoc import /tmp/hcd-dn-run/accept-xlsx.xlsx \
  --output /tmp/hcd-dn-run/accept-xlsx.hcd --document-id accept-xlsx
python3 - <<'PY'
import gzip, json
from pathlib import Path
bundle = Path('/tmp/hcd-dn-run/accept-xlsx.hcd')
def read(p):
    p = bundle / p
    return json.loads(gzip.open(p, 'rt').read()) if p.suffix == '.gz' else json.loads(p.read_text())
index = read(read(bundle / 'manifest.json')['indexRootHref'])
ids = {}
for href in index['children']:
    for chunk in read(href).get('chunks', []):
        grid = chunk.get('grid') or {}
        if grid.get('kind') == 'cells':
            ids[grid['sheetName']] = grid['sheetId']
# 表 ID 从包里读出来，不手抄：它是内容寻址的，抄错一个字符补丁那趟就报 invalid target
print({name: sid for name, sid in ids.items()})
steps = [
    ('hcd-patch/12', 'xlsx.row.insert', {'beforeRow': 3}),
    ('hcd-patch/13', 'xlsx.column.insert', {'beforeColumn': 2}),
    ('hcd-patch/14', 'xlsx.row.delete', {'row': 3}),
]
for rev, (schema, op, values) in enumerate(steps):
    patch = {'schemaVersion': schema, 'documentId': 'accept-xlsx', 'patchId': f'define-name-{rev + 1}',
             'baseRevision': rev, 'operations': [{'op': op, 'sheetId': ids['Order Form'], **values}]}
    Path(f'/tmp/hcd-dn-run/patch-{rev}.json').write_text(json.dumps(patch))
PY
for rev in 0 1 2; do
  target/debug/officecli hdoc apply /tmp/hcd-dn-run/accept-xlsx.hcd \
    --patch /tmp/hcd-dn-run/patch-$rev.json --expected-revision $rev
  target/debug/officecli hdoc validate /tmp/hcd-dn-run/accept-xlsx.hcd
  target/debug/officecli hdoc export /tmp/hcd-dn-run/accept-xlsx.hcd \
    --source /tmp/hcd-dn-run/accept-xlsx.xlsx --revision $((rev + 1)) \
    --output /tmp/hcd-dn-run/export-$rev.xlsx --fidelity-report /tmp/hcd-dn-run/fid-$rev.txt
done
for rev in 0 1 2; do
  echo "revision $((rev + 1)):"
  unzip -p /tmp/hcd-dn-run/export-$rev.xlsx xl/workbook.xml | grep -o '<x:definedName[^<]*'
done
```

三条修订都是 `HIGH`。命名区域跟着格子走：

| 修订 | 这一趟做了什么 | `Print_Area` |
|------|----------------|--------------|
| r0（源） | — | `'Order Form'!$A$1:$D$25` |
| r1 | 第 3 行前插一行（`hcd-patch/12`） | `'Order Form'!$A$1:$D$26` |
| r2 | 再在第 2 列前插一列（`hcd-patch/13`） | `'Order Form'!$A$1:$E$26` |
| r3 | 再删掉第 3 行（`hcd-patch/14`） | `'Order Form'!$A$1:$E$25` |

末行 25 ≥ 3 → 变成 26；首行 1 在插入点上面 → 不动。第 2 列插一列之后，末列 `D` ≥ 2 → `E`，首列 `A` 不动；删回第 3 行，末行回到 25。写出来的还是 `x:definedName`、`x:` 前缀一个不丢，页签拼法照抄源里的带引号写法 `'Order Form'!`。

导出的包只该动的动了：

```bash
python3 - <<'PY'
import zipfile
from pathlib import Path
root = Path('/tmp/hcd-dn-run')
src = zipfile.ZipFile(root / 'accept-xlsx.xlsx')
for rev in (0, 1, 2):
    out = zipfile.ZipFile(root / f'export-{rev}.xlsx')
    print(rev + 1, [n for n in sorted(src.namelist()) if src.read(n) != out.read(n)])
PY
```

```text
1 ['xl/workbook.xml', 'xl/worksheets/sheet3.xml']
2 ['xl/workbook.xml', 'xl/worksheets/sheet3.xml']
3 ['xl/workbook.xml', 'xl/worksheets/sheet3.xml']
```

其余部件（另外两张表、`styles.xml`、`sharedStrings.xml`、图表与图片、`[Content_Types].xml`）逐字节照抄源包。

没有名字被带动的时候，`xl/workbook.xml` 一个字都不改。把上面这套换成移 `Laptops`（没有命名区域指着它，`/tmp/hcd-dn-run5`）：

```text
definedNames 整块与源包逐字节一致：True
workbook.xml 唯一的差别：+<x:calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>
```

那一条 `calcPr` 是任何一次移位都会写的重算标记（`a2fd7f2` 公式那一片开始在写，跟这一片无关）。`changed == false` 的时候导出根本不把 `xl/workbook.xml` 放进替换表，所以“名字没动 → 部件没动”是结构上的，不是碰巧。

前后对比用同一份包、同一个修订：`7501b63`（改之前）编出来的二进制导 r1 报

```text
Error: unsupported mode: XLSX grid shift cannot update a defined name on the edited sheet
```

改过之后同一条命令导出 `HIGH`，名字写成 `'Order Form'!$A$1:$D$26`。`/tmp/hcd-prefix-src` 是 `git archive HEAD` 出来的，`cargo build -p officecli --target-dir /tmp/hcd-prefix-target` 得到改之前的 `officecli`，两份二进制对同一个 `.hcd` 跑同一条 `hdoc export`。

## 跟着走的地址长什么样

`_xlnm.Print_Area` 只是最常见的一条。检查这一趟认得的是命名区域的**地址表**，不是表达式：

| 写法 | 认不认 | 移位怎么算 |
|------|--------|------------|
| `Data!$A$1:$D$11`、`'Data'!$B$4` | 认 | 两个端点各按行/列移位走 |
| `'Data'!$1:$2`（整行） | 认 | 两个行端点走 |
| `'Data'!$A:$B`（整列） | 认 | 两个列端点走 |
| `Data!` / `'Data'!` / `data!`（大小写不同） | 认 | 先按源写下的拼法找表，找不到再不分大小写找一次 |
| `'Order Form'!`、`'A''b'!`（引号里套引号）、非 ASCII 页签名 | 认 | 只重写地址，页签那一截连引号原样抄回去 |
| `Data!$A$1 Data!$E$6`、`…,…`（空格/Tab/换行/逗号分隔多区域） | 认 | 每个区域各自判、各自改 |
| `localSheetId="2"` 的名字里写裸地址 `$B$5:$C$5` | 认 | 按它自己作用域那张表算移位 |
| `SUM(Data!$A$1:$A$5)`、`0.5`、`TRUE`、`#N/A` | 不认 | 读不出端点，拒绝并报名字 |
| 全局名字里的裸地址（没有 `localSheetId`） | 不认 | 归属看谁在读它，没有一张表可以拿来算，拒绝 |
| `'[1]Sheet'!A1`、被历史删掉的表、加载项的表 | 不动 | 表名对不上源簿的页签 → 这不是被移位那张表，照原样留着 |
| `Data!$XFD$1` 再往第 1 列前插一列 | 不认 | 端点被推出 16384 列（行那一侧是 1048576），拒绝并报名字 |

“不认”的那些里，只有值里出现了 `!` 而且点的不是被移位那张表的才放行 —— 一条不含 `!` 的名字（`0.5`、`SUM(...)` 不带表名）有可能算的就是被移位那张表，所以照旧拒绝。这一条跟改之前完全一致：这一片只是把“能算”的部分放出来，没有把任何原本拒绝的构造放成通过。

单行的整行/整列写法（`Data!$3`）也不认：它和“名字存的一个常数”长得一模一样，宁可当成读不懂。所以 `42` 这种值报 `cannot update the defined name`，不会被当成第 42 行。

## 整行、整列按端点走

`'Data'!$1:$2` 在第 3 行前插一行之后还是 `$1:$2`；`'Data'!$3:$9` 在第 3 行前插一行会变成 `$4:$10`。Excel 在边界上插行会把插入点吸收进区域（`$3:$9` 插第 3 行 → `$3:$10`），这里不做那套：**两个端点各自按“插在其前/其后”移动**，跟 HCD 自己重算窗口、跟移位搬 `mergeCells`、搬 `topLeftCell`/`activeCell`/`sqref`、搬源窗格带宽用的是同一套端点规则。打印标题 `'Data'!$1:$2` 因此不会被插一次就悄悄多带一行。

行、列两侧同时移位时（一片里既插行又插列，或者历史里先插行再插列），地址两个轴一起算，`$` 跟着源写下的走。

## 落在导出路径上的哪一步

`xl/workbook.xml` 是好几个 pass 叠出来的，顺序是：重算标记 → **命名区域移位** → 页签改名 → 删除页签（丢控件元素、丢该表作用域的名字）→ 新增页签。放在改名之前，是因为这一片读的是**源**写下的页签名（`workbook.sheets` 里存的从来就是源名字，改名是另外几趟文本 pass），这样 `'Order Form'!` 这种拼法先按源认出来、改好地址，再由改名那趟把新旧表名换掉；反过来做就要拿新名字去查一张移位表，中间多一层歧义。

`localSheetId` 数的是**源**的页签序号，HCD 自己新增的页签不占这个号（`GridShiftNames::new` 把 `added_parts` 过滤掉），所以移位的裸地址落在正确的表上，也不会因为历史上加过页签而错位。

拒绝发生在检查那一趟（`verify_grid_shift_source`），在任何一个字节的包被写出去之前，报 `failed to read part: …` 之外的原文是 `Error: unsupported mode: XLSX grid shift cannot update the defined name {name}`（HTTP 侧 `Unsupported` → 422）。

## 覆盖与不覆盖

对应 Rust 测试（`crates/hcd-formats/src/xlsx.rs` 的 `xlsx::tests`）：

- `a_defined_name_address_moves_with_the_grid_its_tab_shifts` —— 拼法、引号、大小写、多区域、作用域裸地址、以及四类拒绝（公式、全局裸地址、常数、被推出列限）。
- `the_workbook_keeps_the_names_a_grid_shift_never_moves` —— XML 那一趟写回：改到的名字、没改到的名字、`changed == false` 时与源包逐字节一致，以及点名报错。
- `a_grid_shift_moves_the_defined_names_that_ranged_over_the_sheet` —— r0/r1/r2/r3 四份修订的历史累加（就是上面表格那三步的夹具版），`sheet1.xml` 与 `[Content_Types].xml` 逐字节一致，不动网格的修订导出等于源包。
- `a_defined_name_the_shift_cannot_count_still_stops_the_export` —— 一条 `Total` = `SUM(Data!$A$1:$A$2)` 让整条导出停在检查那一趟。

`cargo test -p hcd-formats --lib` 150 条全过，`cargo test -p hcd-core --lib` 72 条全过，`cargo fmt -- --check` 干净。

这一片不碰的：

- 名字里的**公式**照旧拒绝。要把 `SUM(Data!$A$1:$A$5)` 也移了，得先有一台 A1 表达式解析器 —— 移位路径上公式那几片只处理单元格里存的公式，不处理 `definedName` 里的。
- `budget-tracker.xlsx`（三条命名区域：`_xlnm._FilterDatabase` 作用域在 `Transactions`，`DeptList` 与 `CatList` 指着 `Settings`）拿同一份源、同一个修订（第 5 行前插一行）跑两份二进制，前一张墙换成了后一张：

  | 表 | 改之前（`7501b63`） | 改之后 |
  |----|--------------------|--------|
  | `Transactions` | `XLSX grid shift cannot update a defined name on the edited sheet` | `failed to read part: grid shift cannot update worksheet element autoFilter` |
  | `Settings` | 同上 | `failed to read part: grid shift cannot update worksheet element sheetProtection` |
  | `Overview` | `invalid argument: insert before a materialized XLSX row`（补丁那趟，与命名区域无关） | 同一条 |

  命名区域不再是这两张表的原因了。这张表记的是本片刚落盘时的实测：那时 `Transactions`、`Settings` 都还插不出行，能一路走通的是 `product-catalog.xlsx`。`autoFilter` 那条紧接着在下一片关掉了（见 [XLSX 行/列移位把自动筛选和数据验证一起带走](hcd-xlsx-grid-shift-filter-validation.md)），`sheetProtection` 再下一片也关掉了（见 [XLSX 行/列移位放行受保护的工作表](hcd-xlsx-grid-shift-protection.md)），所以这两张表现在都插得出行；照旧不动的是 `Overview` 那条补丁侧的物化窗口。
- 图表、表格（`tableParts`）、超链接的坐标引用仍旧按各自的规则改或拒绝；命名区域跟它们不是同一条路径。数据验证后来也接上了（见 [XLSX 行/列移位把自动筛选和数据验证一起带走](hcd-xlsx-grid-shift-filter-validation.md)），共用这一片的地址表读法。
- 整窗重建把 `mergeCells` 按记录顺序重排那条边界照旧（见 `docs/acceptance/hcd-xlsx-sheet-freeze.md`），内容条数一条不差、顺序不同。
- 没有源文件走 `--to xlsx` 的语义导出，本来就不读 `xl/workbook.xml`，与这一片无关。

`docs/acceptance/hcd-xlsx-sheet-freeze.md` 里“拿 `Transactions` 试插删行先撞上 `definedName` 那条旧边界”一句记的是当时的实测；那条边界现在关了，`Transactions` 卡住的 `autoFilter`/`dataValidation`/`extLst` 也在下一片一起关了。
