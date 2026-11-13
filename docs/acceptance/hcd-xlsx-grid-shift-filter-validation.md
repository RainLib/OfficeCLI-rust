# XLSX 行/列移位把自动筛选和数据验证一起带走

`assets/showcase/budget-tracker.xlsx` 的 `Transactions` 是这份簿子里唯一一张真能拿来插删行的表：三行里 `Overview` 的行不在物化窗口里（补丁那趟就拒），`Settings` 带 `sheetProtection`，只有 `Transactions` 该走得通 —— 可它自己部件里写着一段自动筛选，于是命名区域那条边界关掉（见 [XLSX 行/列移位把 workbook 里的命名区域一起带走](hcd-xlsx-grid-shift-defined-names.md)）之后，同一份源、同一个修订换成撞下一张墙：

```
Error: unsupported mode: failed to read part: grid shift cannot update worksheet element autoFilter
```

自动筛选是真实簿子里最常见的东西：表头一行筛选下拉（`<autoFilter ref="A1:G21">`），下面按列筛（`<filterColumn colId="…">`），配上按部门/按状态下拉的验证规则（`<dataValidation sqref="B2:B100">`）。这条边界实际等于“开了筛选的表不能插删行/列”，而开了筛选的表正是簿子的主体。这一片把它改成**只重写会被这趟移位带动的地址**：筛选区、排序区、验证区跟着格子走，筛在“哪一列”上的按筛选区自己的首列重新数，公式里点到的地址按行/列改；算不动的照旧在写第一个字节之前拒绝。

没有新增号段：补丁侧一个字没改，`hcd-patch/12`/`13`/`14`/`15` 的形状、边界、`baseRevision` 要求跟原来一样；改的全在 `crates/hcd-formats/src/xlsx.rs` 的源文件导出路径上。**也不是“加筛选功能”** —— 加/删/改筛选本身还是没做（那是 `xlsx.sheet.filter`，47–49 号段还没登记），这一片只保证簿子里已经写下来的那份筛选在移位之后还指着原来的那块区域。

## 复现

```bash
cargo build -p officecli
mkdir -p /tmp/hcd-af-run
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-af-run/bt.xlsx
target/debug/officecli hdoc import /tmp/hcd-af-run/bt.xlsx \
  --output /tmp/hcd-af-run/bt.hcd --document-id bt
python3 - <<'PY'
import gzip, json
from pathlib import Path
bundle = Path('/tmp/hcd-af-run/bt.hcd')
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
    ('hcd-patch/12', 'xlsx.row.insert', {'beforeRow': 5}),
    ('hcd-patch/14', 'xlsx.row.delete', {'row': 5}),
    ('hcd-patch/13', 'xlsx.column.insert', {'beforeColumn': 2}),
]
for rev, (schema, op, values) in enumerate(steps):
    patch = {'schemaVersion': schema, 'documentId': 'bt', 'patchId': f'filter-{rev + 1}',
             'baseRevision': rev, 'operations': [{'op': op, 'sheetId': ids['Transactions'], **values}]}
    Path(f'/tmp/hcd-af-run/patch-{rev}.json').write_text(json.dumps(patch))
PY
for rev in 0 1 2; do
  target/debug/officecli hdoc apply /tmp/hcd-af-run/bt.hcd \
    --patch /tmp/hcd-af-run/patch-$rev.json --expected-revision $rev
  target/debug/officecli hdoc validate /tmp/hcd-af-run/bt.hcd
  target/debug/officecli hdoc export /tmp/hcd-af-run/bt.hcd \
    --source /tmp/hcd-af-run/bt.xlsx --revision $((rev + 1)) \
    --output /tmp/hcd-af-run/export-$rev.xlsx --fidelity-report /tmp/hcd-af-run/fid-$rev.txt
done
```

三条修订都 `Applied` + `HCD validation passed` + `High fidelity`（表 ID：`Overview` `s_222b835672e046350863c446fda14a66`、`Transactions` `s_f57075da86f25afd0ac5a8b6e584b9be`、`Settings` `s_ca432f6ffc80a41638eee954b012e4a7`）。筛选区和验证区一起走：

| 修订 | 这一趟做了什么 | `autoFilter` | 部门验证 `sqref` | 状态验证 `sqref` | 条件格式 `sqref` | `_FilterDatabase` |
|------|----------------|--------------|------------------|------------------|------------------|-------------------|
| r0（源） | — | `A1:G21` | `B2:B100` | `G2:G100` | `A2:G21` | `Transactions!$A$1:$G$21` |
| r1 | 第 5 行前插一行（`hcd-patch/12`） | `A1:G22` | `B2:B101` | `G2:G101` | `A2:G22` | `Transactions!$A$1:$G$22` |
| r2 | 再删掉第 5 行（`hcd-patch/14`） | `A1:G21` | `B2:B100` | `G2:G100` | `A2:G21` | `Transactions!$A$1:$G$21` |
| r3 | 再在第 2 列前插一列（`hcd-patch/13`） | `A1:H21` | `C2:C100` | `H2:H100` | `A2:H21` | `Transactions!$A$1:$H$21` |

四个地址、一条命名区域，改的是同一块区域，所以它们改完仍然互相吻合 —— 条件格式那一条不是这片新加的（`conditionalFormatting` 早就会跟着走），拿来当参照：筛选区从 r1 起跟它一致，r3 起 `$G2="Pending"` 那条规则公式也一起变成 `$H2="Pending"`。`B2:B100`/`G2:G100` 这种一直写到第 100 行的“往下留白”验证区，末行在插入点下面 → 一起 +1，所以筛出来的部门下拉在新增行上照样有效。`pane ySplit="1" topLeftCell="A2"` 在第 5 行插行时不动（插入点在冻结带下面），这是上一片（`hcd-patch/45` 与源窗格那一片）的规则。

源里那段筛选是 WPS 写的，带自己那套拼法：

```xml
<autoFilter ref="A1:G21" xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData"
            etc:filterBottomFollowUsedRange="0"><extLst/></autoFilter>
```

导出来 `ref` 换了值，`xmlns:etc` 声明和 `etc:filterBottomFollowUsedRange="0"` 一个字符没改，`<extLst/>` 还在（空扩展列表放行，里面一旦有 `ext` 就拒绝）。两条验证的 `promptTitle="Department"`、`prompt="Select a department"` 原样带着；`formula1` 里那一串写死的下拉选项 `&quot;Engineering,Marketing,Sales,HR,Operations,R&amp;D,Legal&quot;` 转义只有一份 —— 见下面“抄回去的那一段”那条。

导出的包只该动的动了：

```bash
python3 - <<'PY'
import zipfile
from pathlib import Path
root = Path('/tmp/hcd-af-run')
src = zipfile.ZipFile(root / 'bt.xlsx')
for rev in (0, 1, 2):
    out = zipfile.ZipFile(root / f'export-{rev}.xlsx')
    print(rev + 1, [n for n in sorted(src.namelist()) if src.read(n) != out.read(n)])
PY
```

```text
1 ['xl/workbook.xml', 'xl/worksheets/sheet2.xml']
2 []
3 ['xl/workbook.xml', 'xl/worksheets/sheet2.xml']
```

第 2 行是这一趟最好看的一条证据：**插一行再删回同一行，整个包 32 个部件逐字节等于源文件** —— 筛选区、两条验证区、命名区域、`calcPr` 全部回到原位，没有“改过一轮就回不去”的漂移。另外两张表、`styles.xml`、`sharedStrings.xml`、`[Content_Types].xml` 任何时候都是照抄源包。

前后对比用同一份包、同一个修订：`f72bef0`（改之前）编出来的二进制导 r1 报

```text
Error: unsupported mode: failed to read part: grid shift cannot update worksheet element autoFilter
```

而且不在磁盘上留文件；改过之后同一条命令 `High fidelity`，筛选区写成 `A1:G22`。`/tmp/hcd-prefix-src2` 是 `git archive HEAD` 出来的（HEAD 即 `f72bef0`，含上一片的命名区域修正，所以报错点名的是 `autoFilter` 而不是 `definedName`），`cargo build -p officecli --target-dir /tmp/hcd-prefix-target2` 得到改之前的 `officecli`。

同一份簿子里另外两张表，改之后仍然各自卡原来的地方（这一片没动它们）：

| 表 | 命令 | 结果 |
|----|------|------|
| `Settings` | `hdoc apply` + `hdoc export` | 补丁通过，导出报 `failed to read part: grid shift cannot update worksheet element sheetProtection`（记的是本片当时实测，那条墙已在下一片关掉） |
| `Overview` | `hdoc apply` | `Error: unsupported mode: insert before a materialized XLSX row`（补丁那趟，与筛选无关） |

## 跟着走的地址，和跟着数的那一列

筛选这一块有两类坐标，改法不一样。

**一类是地址**：`autoFilter/@ref`、`sortState/@ref`、`sortCondition/@ref`、`dataValidation/@sqref` 走的是跟命名区域、`mergeCells`、`topLeftCell`/`activeCell`/`selection/@sqref` 完全同一套端点规则（`shifted_xlsx_area_list` 拆开区域表，每个端点交给命名区域在用的 `shift_defined_name_endpoint`）：插在其前的 ≥ 点 +1、删掉的 > 点 −1，行、列两个轴一起算，`$` 跟着源写下的走，多区域（`A2 A5:A6`）逐个判，空格/Tab/换行/逗号分隔符照抄。整行整列写法（`A:C`、`3:9`）也认，单行的裸行号/列号（`42`）不认 —— 它和“元素里写的一个数”长得一样。跟命名区域唯一不一样的地方：工作表元素不点表名，`ref` 里出现 `Data!$A$1:$C$12` 这种带页签的写法是**拒绝**而不是按那张表算，因为这个元素属于它所覆盖的那张表，点了别的表就不是这张表的区域。

**另一类是列序号**：`filterColumn/@colId` 不是地址，是“从筛选区首列往右数第几列”。移位改了首列，光改 `colId` 会把它指到别的列上去，所以这里**换算的是绝对列**：`first + colId` 先按真实列走一遍移位，再减去移位后的 `first`（`shifted_filter_column_id`）。`A1:C12` 上 `colId="1"`（即 `B` 列）在第 2 列前插一列之后筛选区变 `A1:D12`，`B`→`C`，于是 `colId` 写成 `2` —— 还是指着那一列的筛选条件。删掉的正好是筛选区起始那一列时，后继列顶上来占住那个地址，于是每个条件的序号都收窄一格（`A1:C12` 上 `colId="2"` 删 A 列 → `1`）：绝对列没变，只是量尺的原点吸收了被删的那一列。

`colId` 这里有四条拒绝，都点名筛选：

- 删掉的正是挂着筛选条件那一列 → `grid shift deletes the column a worksheet filter is set on`。条件描述的是已经不存在的格子，把它挪到后继列上是猜。
- 筛选区读不出首列（缺失、多区域、整行写法、被推出 16384 列）→ `grid shift cannot update a worksheet filter whose range it cannot read a column from`。
- `colId` 不是整数 → `grid shift cannot update a worksheet filter whose column is not a whole column count`。
- 算出来的序号跑到筛选区首列之前（负数）→ `grid shift moves a column's criteria ahead of the filter's own range`；那一列被推出 16384 列 → `grid shift moves a worksheet filter past the last column`。

**只动行的移位根本不碰这些元素的字节**：`colId` 那一路直接返回“没东西移动”，`ref`/`sqref` 那一路两个端点都没变时也照抄原字节。所以拿 `Transactions` 插一行，写出来的 `autoFilter` 起始标签除了 `ref` 那一个属性以外与源完全一致，不是“重新拼一遍正好一样”。

**验证规则的公式**（`formula1`/`formula2`）走的是单元格公式那台 A1 重写器（`rewrite_grid_formula`），跟条件格式 `<formula>` 同一条路：`$C$5` 在第 2 列前插一列变 `$D$5`；写死的列表 `"Engineering,Marketing,R&D"` 里没有地址 → 一个字不改；指着别的表（`Settings!$A$2:$A$8`）或者读不懂的表达式 → 拒绝，跟跨表公式一样不做无声的猜测。

**筛选条件本身的词汇** —— `filters`/`filter`/`customFilters`/`customFilter`/`top10`/`dynamicFilter`/`colorFilter`/`iconFilter` —— 点名的都是值、颜色、图标、前十大，不含格子地址，原样带着。

## 抄回去的那一段

这一片真正改掉的一个 bug 在“不动的东西怎么抄”。起始标签重写时，改过值的属性重新拼，没改过的属性**按字节**抄回去：

```rust
} else {
    // Untouched attributes carry along as the bytes that arrived: a value
    // the workbook escaped is re-escaped if it is handed over as text, and the
    // prompt a validation rule shows the user would gain a second `&amp;` on
    // every export.
    rewritten.push_attribute((attribute.key.as_ref(), attribute.value.as_ref()));
}
```

写成 `push_attribute((key.as_str(), value.as_str()))` 会走 quick-xml 的转义：源里 `R&amp;D` 一次导出变 `R&amp;amp;D`，`&quot;list&quot;` 变 `&amp;quot;list&amp;quot;`，而且每导一次再叠一层。公式文本同一道理：`<formula1>` 的值没被移位改动时用 `BytesText::from_escaped` 写原始字节，改动了才按转义文本写。这两个分支都由 `a_grid_shift_moves_a_filter_and_the_ranges_it_validates` 里对 `&quot;…R&amp;D&quot;`、`promptTitle="Dept &amp; Cat"`、`prompt="Pick a &quot;list&quot;"` 的逐字节断言钉住。同一个写法在已发布的 `rewrite_xlsx_view_attributes` 里也有，那里能进属性的只有 `A1` 这类纯地址、没有可转义字符，所以行为上没有差别，这一片没去动它。

## 落在导出路径上的哪一步

拒绝发生在检查那一趟（`verify_grid_shift_source`），在任何一个字节的包被写出去之前：那趟把要重写的元素**用同一个 `rewrite_xlsx_area_attributes` 跑一遍再把结果丢掉**，所以“检查认得”和“重写会写”不存在两套规矩 —— 一个读不动的 `ref`、一个被删掉的筛选列，在检查这趟就停，不会先写一半。写出去那一趟（`rewrite_worksheet`）里，`autoFilter` 的 `ref` 顺手记在 `filter_range` 上，`</autoFilter>` 结束时清掉，`filterColumn/@colId` 就是从这个原点算的；因此一段筛选里的元素按文档顺序流过去，不需要预先整体解析。

硬拒绝清单这一片从 `{dataValidation, dataValidations, autoFilter, tableParts, hyperlinks, legacyDrawing, extLst}` 收成 `{tableParts, hyperlinks, legacyDrawing}` 三条 —— 表格部件、超链接、批注绘制都要再改这张表以外的部件，不在这片。筛选与验证那一族其余的元素（`sortState`/`sortCondition`/`filterColumn`/`formula1`/`formula2` 和条件词汇那一大堆）以前不是被硬清单拒的，是没进 catch-all 放行清单，现在一起放进去。扩展列表 `extLst` 只在**空**的时候放行：它自己那层进放行清单，里面第一个 `ext` 元素由 catch-all 拒掉，所以不需要跟踪它的深度 —— WPS/Excel 的 `x14:filterColumn` 这类重复条件因此还是整条导出拒绝，宁可不动。

报错分层跟命名区域那一片一致：读不出端点、算不出列、公式跨表都在 `failed to read part: …` 那一层（HTTP 侧 `Unsupported` → 422），点名是哪一段读不懂（`worksheet filter` / `worksheet filter column` / `worksheet sort range` / `worksheet data validation`）。

## 覆盖与不覆盖

对应 Rust 测试（`crates/hcd-formats/src/xlsx.rs` 的 `xlsx::tests`）：

- `a_filter_range_and_the_column_it_filters_on_move_with_the_grid` —— 地址与列序号两条换算规则本身：`A1:C12`→`A1:D13`、`B2:B100`→`C2:C101`、`A2 A5:A6`→`A2 A6:A7`、`$A$1:$D$10`→`$A$1:$E$11`、`A:C`→`A:D`、`3:9`→`4:10`、`B2:$D$12`→`C2:$E$13`；只移行时返回“没动”；`colId` `0→0`/`1→2`/`2→3`、原点右移时序号变小；四类拒绝。
- `a_grid_shift_moves_a_filter_and_the_ranges_it_validates` —— r0/r1/r2/r3 四份修订的历史累加（就是上面那三步的夹具版），断言 `autoFilter`/`sortState`/`sortCondition`/两条 `sqref`/`<formula1>$C$6</formula1>`→`$D$6`→`$D$5`、`filterColumn/@colId`、WPS 的 `xmlns:etc` 与 `etc:filterBottomFollowUsedRange`、`<extLst/></autoFilter>`、写死列表与 `prompt` 的转义只有一份、`<dataValidations count="2">` 的 `count` 不动，未移位那两张表与 `[Content_Types].xml`、`workbook.xml` 逐字节一致，r0 导出等于源包。
- `a_filter_the_shift_cannot_count_still_stops_the_export` —— 四种读不动的形状各自停在检查那一趟，且**没在磁盘上留文件**：`extLst` 里真有 `ext`、`ref="Data!$A$1:$C$12"`（工作表元素不点表名，点了就不是这张表的区域）、`colId` 落在被删掉的列上、`sqref="SUM(A1:A5)"`。同一夹具在没被移位的修订下导出与源逐字节一致。

`cargo test -p hcd-formats --lib` 153 条全过，`cargo test -p hcd-core --lib` 72 条全过，`cargo fmt -- --check` 干净，`cargo clippy -p hcd-formats --all-targets` 在 `xlsx.rs` 上零告警（剩下的 `textual.rs`/`pdf.rs`/`patch.rs`/`oxml`/`pdf-handler` 几条是本片之前就有的）。

这一片不碰的：

- `sheetProtection` —— 记这一片的时候 `Settings` 还插不出一行，那是紧跟的下一片；现在已放行，见 [XLSX 行/列移位放行受保护的工作表](hcd-xlsx-grid-shift-protection.md)。物化窗口的 `Overview` 照旧（补丁侧拒绝）。
- **加/删/改筛选**本身，以及排序条件的编辑、验证规则的新增。这一片只搬已经写下来的地址，没有新的补丁操作、没有新的 schema。
- 表格部件（`tableParts` 指向的 `xl/tables/*.xml`）、超链接、批注 `legacyDrawing`：它们要动这张表以外的部件，仍然硬拒绝。
- 扩展列表里有内容的筛选/验证（Excel 的 `x14` 重复条件）：拒绝，不做“只改主区、留着扩展区”的半改。
- 整窗重建把 `mergeCells` 按记录顺序重排那条边界照旧（见 `docs/acceptance/hcd-xlsx-sheet-freeze.md`）。
- 没有源文件走 `--to xlsx` 的语义导出不读工作部件，与这一片无关。
