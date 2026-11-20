"""Optionally regenerate the synthetic workbook sources for review."""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule
from openpyxl.styles import PatternFill

root = Path(__file__).parent

book = Workbook()
sales = book.active
sales.title = "销售"
for values in [
    ["地区", "品类", "金额", "件数"],
    ["华北", "办公", 40, 2],
    ["华南", "办公", "=C2*2", 3],
    ["华北", "办公", 90, "待核对"],
    ["华北", "设备", 25, 8],
    ["华南", "设备", 5, None],
]:
    sales.append(values)
sales.conditional_formatting.add("C2:C6", CellIsRule(
    operator="greaterThan", formula=["70"],
    fill=PatternFill(patternType="solid", fgColor="FFE7D7F0")))
sales.freeze_panes = "A2"
chart = BarChart()
chart.title = "已有图表"
chart.add_data(Reference(sales, min_col=4, min_row=1, max_row=6), titles_from_data=True)
sales.add_chart(chart, "J10")
summary = book.create_sheet("汇总")
summary["A1"] = "已有备注"
summary["A20"] = "保留尾行"
summary["B1"] = "=SUM(E5:E6)"
book.save(root / "pivot-source.xlsx")

book = Workbook()
sheet = book.active
sheet.title = "Sales"
for values in [["类别", "金额", "报价", "地区"], ["办公", 10, 58, "华北"],
               ["设备", 90, 63, "华南"], ["用品", 160, 110, "华北"]]:
    sheet.append(values)
sheet.freeze_panes = "B2"
sheet.conditional_formatting.add("B2:B4", CellIsRule(
    operator="greaterThan", formula=["80"], stopIfTrue=True,
    fill=PatternFill(patternType="solid", fgColor="FFC8ECF8")))
sheet.conditional_formatting.add("C2:C4", ColorScaleRule(
    start_type="min", start_color="FFFF7F50", end_type="max", end_color="FF55AA77"))
chart = BarChart()
chart.title = "已有图表"
chart.add_data(Reference(sheet, min_col=3, min_row=1, max_row=4), titles_from_data=True)
sheet.add_chart(chart, "G6")
rates = book.create_sheet("Rates")
rates["A1"] = "上期"
rates["B1"] = 42
rates["B2"] = "=B1*2"
book.save(root / "native-conditions-source.xlsx")
