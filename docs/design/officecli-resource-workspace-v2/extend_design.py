"""Extend the existing FigCraft project through its stdio MCP, preserving V1."""
from __future__ import annotations

import json
import math
import struct
import hashlib
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
PREVIOUS = OUT.parent / "officecli-resource-workspace-v1"
sys.path.insert(0, str(PREVIOUS))
import figcraft_mcp as fc
import build_design as bd

SOURCE = PREVIOUS / "officecli-resource-workspace.figcraft"
NATIVE = OUT / "officecli-office-workspace-v2.figcraft"
ASSETS = OUT.parent / "officecli-image-workspace/assets"
PHOTO = ASSETS / "ceramic-portrait.jpg"
CANDIDATE = ASSETS / "vase-repaint-candidate-demo.png"
fc.ROOT, fc.NATIVE = OUT, NATIVE

PALETTE = {
    "Canvas": "#F3F5F8", "Navigation": "#EDF1F6", "Stage": "#FAFBFD",
    "Surface": "#FFFFFF", "Panel": "#FFFFFF", "Ink": "#253248",
    "Muted": "#5F6F86", "Faint": "#5F7088", "Border": "#DDE4EE",
    "Accent": "#486F9D", "AccentSoft": "#EAF0F8", "Sage": "#EBF3EE",
    "SageInk": "#52725E", "BlueSoft": "#EAF0F8", "BlueInk": "#506C92",
    "Yellow": "#F4F1E7", "Bubble": "#EDF2F8", "Dark": "#42658F",
}
OLD = bd.COLORS.copy()
bd.COLORS.update(PALETTE)
C, A = bd.COLORS, bd.Artboard
bd.ICONS.update({
    "crop": "M 5 0 V 14 H 19 M 0 5 H 14 V 19",
    "sliders": "M 0 4 H 18 M 0 10 H 18 M 0 16 H 18 M 5 1 V 7 M 13 7 V 13 M 7 13 V 19",
    "download": "M 9 0 V 13 M 4 8 L 9 13 L 14 8 M 0 15 V 19 H 18 V 15",
    "undo": "M 5 1 L 0 6 L 5 11 M 0 6 H 10 C 19 6 19 18 10 18",
    "filter": "M 0 0 H 18 L 11 8 V 16 L 7 19 V 8 Z",
    "chart": "M 0 0 V 18 H 19 M 5 15 V 9 M 10 15 V 3 M 15 15 V 6",
    "comment": "M 0 0 H 18 V 13 H 7 L 2 18 V 13 H 0 Z M 4 4 H 14 M 4 8 H 11",
    "ppt": "M 0 0 H 18 V 14 H 0 Z M 9 14 V 19 M 5 19 H 13 M 5 4 L 12 7 L 5 10 Z",
    "pdf": "M 1 0 H 11 L 17 6 V 20 H 1 Z M 11 0 V 6 H 17 M 5 14 L 10 8 L 13 15 L 5 14",
    "save": "M 0 0 H 14 L 18 4 V 18 H 0 Z M 4 0 V 7 H 13 V 0 M 4 18 V 11 H 14 V 18",
    "print": "M 4 0 H 14 V 5 H 4 Z M 4 14 H 14 V 19 H 4 Z M 4 15 H 0 V 6 H 18 V 15 H 14",
})

AI_ID = 56
RESOURCES = [
    ("board", "筹备白板", "board", "白板"),
    ("word", "产品发布方案", "doc", "文字"),
    ("excel", "发布预算", "sheet", "表格"),
    ("image", "图片素材", "image", "图片"),
    ("ppt", "发布汇报", "ppt", "演示"),
    ("pdf", "发布手册", "pdf", "PDF"),
]


def walk(node, skip_instances=False):
    yield node
    if skip_instances and node.get("type") == "INSTANCE": return
    for child in node.get("children", []): yield from walk(child, skip_instances)


def image(a, parent, x, y, width, height, path=PHOTO, name="Source photograph", opacity=1):
    alias = f"{a.key}_image_{len(a.commands)}"
    a.commands.append({"command": "image.place", "as": alias, "params": {
        "path": str(path), "x": x, "y": y, "width": width, "height": height,
        "parent": {"$ref": parent} if isinstance(parent, str) else parent,
        "name": name, "mode": "fit"}})
    if opacity != 1:
        a.commands.append({"command": "node.set", "params": {"ids": [{"$ref": alias}], "props": {"opacity": opacity}}})
    return alias


def navigation(a, active):
    p = a.frame(a.root, 12, 12, 184, 976, "Workspace navigation", C["Navigation"], radius=20)
    a.star(p, 17, 21, 25)
    a.text(p, 52, 19, "OfficeCLI", 18.5, bold=True, family="Georgia")
    a.icon(p, 151, 24, "sidebar", 17)
    a.button(p, 12, 75, "新建", 160, icon="plus", target="library")
    a.icon(p, 24, 135, "search", 16)
    a.text(p, 50, 129, "搜索工作空间", 13, C["Muted"])
    home = a.frame(p, 12, 180, 160, 37, "Workspace home", C["Surface"] if active == "library" else C["Navigation"], radius=10)
    a.icon(home, 12, 10, "folder", 17, C["Accent"])
    a.text(home, 39, 6, "我的工作台", 13, bold=active == "library")
    a.hit(home, 0, 0, 160, 37, "library", "打开工作台")
    a.text(p, 24, 244, "产品发布", 11, C["Muted"], bold=True)
    for i, (key, title, icon, _) in enumerate(RESOURCES):
        yy = 280 + i * 42
        selected = active == key
        if selected: a.rect(p, 12, yy - 4, 160, 36, C["Surface"], 10, "Active resource")
        a.icon(p, 25, yy + 5, icon, 15, C["Accent"] if selected else C["Muted"])
        a.text(p, 50, yy - 1, title, 12.5, C["Ink"] if selected else C["Muted"], bold=selected)
        a.hit(p, 12, yy - 4, 160, 36, key, "打开" + title)
    a.line(p, 20, 563, 144)
    a.text(p, 24, 586, "最近对话", 11, C["Muted"], bold=True)
    a.icon(p, 25, 625, "chat", 15)
    a.text(p, 50, 618, "发布准备检查", 12.5, C["Muted"])
    a.text(p, 50, 647, "对话与任务跨文件持续", 10.5, C["Faint"], width=118)
    a.rect(p, 13, 793, 158, 90, C["AccentSoft"], 14, "Workspace helper")
    a.text(p, 26, 807, "一个工作空间", 12.5, C["Accent"], bold=True)
    a.text(p, 26, 834, "文字、表格与图片，\n与 AI 一起继续。", 11.5, C["Muted"], width=132)
    a.line(p, 20, 911, 144)
    a.rect(p, 22, 932, 28, 28, "#DCE5F1", 14, "User avatar")
    a.text(p, 30, 934, "W", 13, family="Inter", bold=True)
    a.text(p, 61, 930, "我的工作空间", 12.5)


def shell(a, active, title, selected="", image_task=False):
    navigation(a, active)
    a.text(a.root, 214, 24, "产品发布", 13, C["Muted"])
    a.text(a.root, 286, 24, "/", 13, C["Faint"])
    a.text(a.root, 305, 23, title, 14, bold=True)
    a.chip(a.root, 490, 22, "已保存", C["Sage"], C["SageInk"], 64, h=24)
    a.button(a.root, 1210, 19, "历史", 76, icon="clock", target="history" if active == "image" else "review")
    a.button(a.root, 1297, 19, "分享", 77)
    a.button(a.root, 1386, 19, "导出", 77, icon="download", target="convert" if active == "image" else "pdf")
    a.button(a.root, 1474, 19, "全局 AI", 114, icon="chat", target="ai")
    x = 208
    for key, name, icon, _ in RESOURCES:
        width = {"board": 140, "word": 176, "excel": 142, "image": 154, "ppt": 154, "pdf": 154}[key]
        p = a.frame(a.root, x, 76, width, 40, "Resource tab/" + name,
                    C["Surface"] if key == active else C["Canvas"],
                    C["Border"] if key == active else None, radius=12)
        a.icon(p, 12, 12, icon, 15, C["Accent"] if key == active else C["Muted"])
        a.text(p, 37, 8, name, 12.5, C["Ink"] if key == active else C["Muted"], bold=key == active)
        a.hit(p, 0, 0, width, 40, key, "切换" + name)
        x += width + 8
    stage = a.frame(a.root, 208, 128, 1024, 860, "Main stage / 26px", C["Stage"], C["Border"], radius=26, clip=True)
    alias = f"{a.key}_globalAI"
    a.commands.append({"command": "instance.create", "as": alias, "params": {
        "component": AI_ID, "x": 1244, "y": 76, "parent": {"$ref": a.root}}})
    props = {"CurrentPage": "当前：" + title, "HasSelection": bool(selected),
             "Selection": selected or "选区：当前页面",
             "Reply": "我会结合当前资料继续工作。\n已固定的方案和预算仍保留在此对话中。"}
    if image_task:
        props.update(Prompt="把花瓶调整为鼠尾草绿釉，\n保留瓶型、花纹和反光。",
                     Reply="图片与涂抹区域已加入当前任务。\n我会先生成候选，再由你对比和应用。",
                     TaskTitle="图片局部重绘", TaskFirst="已读取原图与涂抹区域",
                     TaskSecond="候选生成 · 等待核对",
                     Suggestion="继续此图片任务", NextStep="先生成局部候选，再核对并应用结果。",
                     TaskStatus="待核对" if a.key == "compare" else "进行中" if a.key == "progress" else "待开始")
    a.commands.append({"command": "instance.setProperties", "params": {
        "ids": [{"$ref": alias}], "properties": props}})
    a.hit(a.root, 1513, 187, 57, 28, "ai", "管理全局上下文")
    return stage, alias


def titlebar(a, p, title, icon="doc", status="正在编辑", back="board"):
    a.icon(p, 23, 22, icon, 19, C["Accent"])
    a.text(p, 55, 15, title, 16, bold=True)
    a.chip(p, 738, 18, status, C["AccentSoft"], C["Accent"], 140, h=25)
    a.button(p, 891, 14, "回到白板", 109, icon="back", target=back, h=33)
    a.line(p, 22, 62, 980)


def ribbon(a, p, kind="word", review=False):
    labels = ["文件", "开始", "插入", "布局", "引用", "审阅", "视图"] if kind == "word" else ["文件", "开始", "插入", "公式", "数据", "审阅", "视图"]
    for i, label in enumerate(labels):
        x = 26 + i * 67
        selected = label == ("审阅" if review else "开始")
        if selected: a.rect(p, x - 8, 69, 53, 31, C["AccentSoft"], 8)
        a.text(p, x, 74, label, 12.5, C["Accent"] if selected else C["Muted"], bold=selected)
        if label == "审阅": a.hit(p, x - 8, 69, 53, 31, "review", "打开审阅")
        if label == "数据" and kind == "excel": a.hit(p, x - 8, 69, 53, 31, "data", "打开数据工具")
    a.button(p, 859, 70, "查找与替换", 141, icon="search", target="find" if kind == "word" else "excel_find", h=29)
    a.line(p, 22, 108, 980)
    if review:
        tools = [("comment", "新建批注"), ("check", "修订"), ("check", "接受修改"), ("close", "拒绝修改"), ("back", "上一处"), ("right", "下一处")]
        for i, (icon, label) in enumerate(tools):
            x = 26 + i * 128
            a.icon(p, x + 10, 124, icon, 19, C["Accent"] if i < 2 else C["Muted"])
            a.text(p, x + 37, 125, label, 12)
        a.text(p, 878, 125, "所有标记  ˅", 12, C["Muted"])
    else:
        a.icon(p, 25, 124, "undo", 18)
        a.text(p, 17, 153, "撤销", 10.5, C["Muted"])
        a.icon(p, 68, 124, "refresh", 18)
        a.text(p, 60, 153, "重做", 10.5, C["Muted"])
        a.line(p, 112, 120, 0, h=55)
        a.frame(p, 128, 120, 143, 30, "Font selector", C["Surface"], C["Border"], radius=7)
        a.text(p, 139, 125, "等线 / PingFang  ˅", 11.5)
        a.frame(p, 280, 120, 61, 30, "Font size", C["Surface"], C["Border"], radius=7)
        a.text(p, 294, 125, "12  ˅", 11.5)
        a.text(p, 132, 158, "B     I     U     A     填充  ˅", 13, family="Inter")
        a.line(p, 359, 120, 0, h=55)
        a.text(p, 379, 125, "≡    ≣    ≡    ¶    ↕", 16, family="Inter")
        a.text(p, 380, 157, "对齐     行距     自动换行", 11.5, C["Muted"])
        a.line(p, 573, 120, 0, h=55)
        a.text(p, 594, 126, "正文     标题 1     标题 2" if kind == "word" else "常规  ˅     ￥     %     .00", 12)
        a.text(p, 595, 157, "样式     插入表格     插入图片" if kind == "word" else "数字格式     边框     合并居中", 11.5, C["Muted"])
        a.line(p, 820, 120, 0, h=55)
        a.icon(p, 840, 125, "doc" if kind == "word" else "filter", 19)
        a.text(p, 872, 125, "页面布局" if kind == "word" else "排序筛选", 12)
        a.text(p, 840, 158, "页眉页脚 · 页码" if kind == "word" else "冻结窗格 · 条件格式", 11, C["Muted"])
        if kind == "excel": a.hit(p, 832, 115, 165, 68, "data", "查看筛选与图表")
    a.line(p, 22, 188, 980)


def word(a, reviewing=False):
    p, _ = shell(a, "word", "产品发布方案.docx", "第 2 节 · 发布节奏")
    titlebar(a, p, "产品发布方案.docx", status="自动保存已开启")
    ribbon(a, p, review=reviewing)
    a.text(p, 24, 211, "文档大纲", 11.5, C["Muted"], bold=True)
    for i, title in enumerate(["发布目标", "发布节奏", "团队分工", "风险与应对"]):
        yy = 259 + i * 43
        if i == 1: a.rect(p, 14, yy - 5, 146, 35, C["AccentSoft"], 9)
        a.text(p, 27, yy, title, 12, C["Accent"] if i == 1 else C["Muted"])
    a.text(p, 23, 611, "版式", 11.5, C["Muted"], bold=True)
    a.text(p, 23, 647, "A4 · 纵向\n页边距 2.54 cm", 11.5, C["Muted"], width=131, line=25)
    paper = a.frame(p, 179, 208, 606 if reviewing else 781, 573, "Document page", C["Surface"], C["Border"], radius=8)
    width = 606 if reviewing else 781
    a.text(paper, 38, 23, "PRODUCT LAUNCH / 2026", 10, C["Faint"], family="Inter")
    a.text(paper, 38, 63, "产品发布方案", 27, bold=True)
    a.text(paper, 38, 113, "02  发布节奏", 19, bold=True)
    a.text(paper, 38, 156, "预热期 · 11.18—11.24", 14, bold=True)
    a.rect(paper, 31, 192, width - 65, 76, C["AccentSoft"], 5, "Selected paragraph")
    a.text(paper, 39, 200, "邀请首批用户，收集核心场景反馈。\n提供清晰的体验指引，并在邀请邮件中说明反馈入口。", 13, width=width - 80, line=27)
    a.text(paper, 38, 300, "发布日 · 11.25", 14, bold=True)
    a.text(paper, 38, 337, "产品开放体验，同步渠道内容与用户支持。", 13, width=width - 80)
    if reviewing:
        a.rect(paper, 38, 371, 394, 27, "#EBF3EE", 3)
        a.text(paper, 42, 373, "新增：由林晓负责发布当日的用户答疑。", 12.5, C["SageInk"])
    else:
        a.text(paper, 38, 380, "阶段分工", 14, bold=True)
        rows = [("预热", "用户邀请与内容准备", "林晓"), ("发布", "渠道上线与用户支持", "余宁"), ("跟进", "反馈整理与复盘", "陈一")]
        for i, row in enumerate(rows):
            xx = 38
            for value, w in zip(row, [95, 424, 100]):
                a.rect(paper, xx, 419 + i * 30, w, 30, C["Stage"] if i % 2 else C["Surface"], 0, "Document table cell", C["Border"])
                a.text(paper, xx + 10, 424 + i * 30, value, 11.5, width=w - 18)
                xx += w
    a.text(paper, 38, 541, "产品发布团队", 10.5, C["Faint"])
    a.text(paper, width - 70, 541, "2 / 4", 10.5, C["Faint"], family="Inter")
    if reviewing:
        comments = a.frame(p, 800, 208, 204, 573, "Review comments", C["Navigation"], radius=14)
        a.text(comments, 14, 13, "批注  2", 13, bold=True)
        a.text(comments, 14, 48, "发布节奏", 11.5, C["Accent"])
        for i, (name, body) in enumerate([("林晓", "邀请邮件里补充反馈入口。"), ("余宁", "发布当天的答疑安排已补齐。")]):
            q = a.frame(comments, 10, 88 + i * 160, 184, 137, "Comment/" + name, C["Surface"], C["Border"], radius=12)
            a.text(q, 12, 10, name, 12.5, bold=True)
            a.text(q, 12, 42, body, 12, width=160, line=24)
            a.text(q, 12, 108, "回复     解决", 11, C["Accent"])
        a.button(comments, 11, 502, "返回编辑", 181, target="word", h=35)
    a.line(p, 23, 804, 978)
    a.text(p, 25, 819, "第 2 页 / 共 4 页    1,286 字    简体中文", 11, C["Muted"])
    a.text(p, 789, 819, "−    100%    +", 11.5, C["Muted"], family="Inter")


def excel(a, analysis=False):
    p, _ = shell(a, "excel", "发布预算.xlsx", "预算!B2:F7")
    titlebar(a, p, "发布预算.xlsx", "sheet", "已自动保存")
    ribbon(a, p, "excel")
    a.frame(p, 22, 202, 102, 31, "Excel name box", C["Surface"], C["Border"], radius=7)
    a.text(p, 35, 207, "F7", 12, family="Inter")
    a.text(p, 141, 206, "fx", 15, C["Muted"], family="Georgia")
    a.frame(p, 178, 202, 822, 31, "Excel formula bar", C["Surface"], C["Border"], radius=7)
    a.text(p, 192, 208, "=SUM(F3:F6)", 12, C["Ink"], family="Inter")
    gx, gy, rw, cw, rh = 24, 250, 44, 132, 44
    rows = [
        ["", "产品发布预算", "", "", "", "", ""],
        ["序号", "项目", "负责人", "数量", "单价", "小计", "状态"],
        ["1", "内容制作", "林晓", "4", "3,000", "12,000", "已确认"],
        ["2", "渠道投放", "余宁", "3", "6,000", "18,000", "待确认"],
        ["3", "用户访谈", "陈一", "8", "500", "4,000", "已确认"],
        ["4", "活动物料", "林晓", "1", "2,000", "2,000", "已确认"],
        ["", "合计", "", "", "", "36,000", ""],
        ["", "", "", "", "", "", ""],
        ["", "", "", "", "", "", ""],
    ]
    for col in range(8):
        xx, ww = (gx, rw) if col == 0 else (gx + rw + (col - 1) * cw, cw)
        a.rect(p, xx, gy, ww, 29, C["Navigation"], 0, "Column header", C["Border"])
        if col: a.text(p, xx + 55, gy + 5, chr(64 + col), 11, C["Muted"], family="Inter")
    for r, row in enumerate(rows):
        yy = gy + 29 + r * rh
        a.rect(p, gx, yy, rw, rh, C["Navigation"], 0, "Row header", C["Border"])
        a.text(p, gx + 16, yy + 12, str(r + 1), 11, C["Muted"], family="Inter")
        for c, value in enumerate(row):
            xx = gx + rw + c * cw
            fill = C["AccentSoft"] if r == 1 else C["Stage"] if r == 6 else C["Surface"]
            a.rect(p, xx, yy, cw, rh, fill, 0, f"Excel cell/{chr(65+c)}{r+1}", C["Border"])
            a.text(p, xx + 11, yy + 11, value, 11.5, width=cw - 18, bold=r in (1, 6))
    a.rect(p, gx + rw + cw, gy + 29 + rh, cw * 5, rh * 6, "none", 0, "Excel selection", C["Accent"], strokeWeight=2)
    a.rect(p, gx + rw + cw*5, gy + 29 + rh*6, cw, rh, "none", 0, "Excel active cell F7", C["Accent"], strokeWeight=2)
    a.text(p, 23, 706, "+     预算     排期     渠道", 12, C["Muted"])
    a.rect(p, 64, 733, 32, 2, C["Accent"], 1)
    a.button(p, 25, 770, "引用区域到白板", 181, icon="board", target="range_board")
    a.button(p, 218, 770, "筛选与图表", 145, icon="chart", target="data")
    a.text(p, 614, 818, "总预算  36,000     100%", 11.5, C["Muted"], family="Inter")
    if analysis:
        chart = a.frame(p, 500, 389, 476, 302, "Excel chart / Budget distribution", C["Surface"], C["Border"], radius=14,
                        effects=[{"type":"dropShadow","color":"#25324814","offset":[0,4],"radius":18}])
        a.text(chart, 19, 15, "预算分布", 15, bold=True)
        a.text(chart, 19, 45, "基于预算!B2:F7", 11, C["Muted"])
        for i, (label, val, height) in enumerate([("内容", "12,000", 116), ("渠道", "18,000", 173), ("访谈", "4,000", 39), ("物料", "2,000", 20)]):
            x = 43 + i * 105
            a.rect(chart, x, 240 - height, 50, height, C["Accent"] if i == 1 else "#A7BCD7", 5, "Budget bar")
            a.text(chart, x - 3, 214 - height, val, 10.5, C["Muted"], width=67, family="Inter")
            a.text(chart, x + 5, 250, label, 11, C["Muted"])
        filt = a.frame(p, 39, 330, 263, 313, "Excel filter / Status", C["Surface"], C["Border"], radius=12,
                       effects=[{"type":"dropShadow","color":"#25324812","offset":[0,5],"radius":18}])
        a.text(filt, 15, 13, "状态筛选", 14, bold=True)
        a.text(filt, 15, 52, "升序排列       降序排列", 11.5, C["Muted"])
        a.line(filt, 14, 88, 235)
        for i, label in enumerate(["全选", "已确认", "待确认"]):
            yy = 110 + i * 42
            a.rect(filt, 16, yy, 16, 16, C["Accent"] if i < 2 else C["Surface"], 4, stroke=C["Border"])
            if i == 0: a.line(filt, 20, yy + 8, 8, C["Surface"])
            elif i == 1: a.icon(filt, 20, yy + 4, "check", 9, C["Surface"])
            a.text(filt, 44, yy - 2, label, 12)
        a.button(filt, 15, 255, "应用筛选", 232, "primary", target="excel")


def field(a, p, y, label, value, width=211):
    a.text(p, 15, y, label, 11.5, C["Muted"])
    a.frame(p, 14, y + 29, width, 34, "Field/" + label, C["Surface"], C["Border"], radius=8)
    a.text(p, 25, y + 36, value, 12, width=width - 22)


def slider(a, p, y, label, value="0", percent=.5):
    a.text(p, 15, y, label, 12)
    a.text(p, 186, y + 1, value, 11, C["Muted"], family="Inter")
    a.rect(p, 15, y + 34, 205, 3, C["Border"], 2)
    a.rect(p, 15, y + 34, 205 * percent, 3, C["Accent"], 2)
    a.rect(p, 10 + 205 * percent, y + 30, 11, 11, C["Surface"], 6, stroke=C["Accent"])


def image_shell(a, mode="image"):
    p, ai = shell(a, "image", "ceramic-portrait.jpg",
                  "图片蒙版 · 花瓶区域" if mode in ("mask", "progress", "compare") else "",
                  image_task=mode in ("mask", "progress", "compare"))
    titlebar(a, p, "ceramic-portrait.jpg", "image", "原图保留", "board")
    modes = [("image", "预览"), ("crop", "裁剪旋转"), ("adjust", "光线色彩"), ("mask", "局部重绘"), ("compare", "对比"), ("convert", "格式转换"), ("history", "历史")]
    x = 22
    selected_mode = "convert" if mode in ("png","jpeg","done") else "mask" if mode == "progress" else mode
    for key, label in modes:
        w = 64 if len(label) == 2 else 100
        if key == selected_mode: a.rect(p, x, 71, w, 31, C["AccentSoft"], 9)
        a.text(p, x + 12, 76, label, 12, C["Accent"] if key == selected_mode else C["Muted"], bold=key == selected_mode)
        a.hit(p, x, 71, w, 31, key, "图片/" + label)
        x += w + 4
    a.icon(p, 937, 78, "expand", 17)
    a.hit(p, 923, 70, 73, 37, "focus", "图片专注模式")
    a.line(p, 22, 114, 980)
    view = a.frame(p, 16, 130, 736, 639, "Image viewport", "#EFF3F8", radius=16)
    q = a.frame(p, 768, 130, 240, 639, "Image tools / Docked parameters", C["Surface"], C["Border"], radius=16)
    a.text(view, 17, 15, "适合窗口", 11, C["Muted"])
    a.text(view, 573, 15, "1080 × 720", 11, C["Muted"], family="Inter")
    a.text(view, 18, 604, "−     58%     +", 11.5, C["Muted"], family="Inter")
    a.text(view, 459, 604, "滚轮缩放 · 空格拖动", 11, C["Muted"])
    # Exact 3:2 aspect; the photo itself has no rounded corners or selection border.
    photo = image(a, view, 30, 113, 676, 450.6667)
    return p, q, view, photo, ai


def vase_mask(a, view, fill="#486F9D66", label=True):
    data = "M 56 0 L 104 0 L 96 28 C 108 47 130 61 147 88 C 164 112 164 137 149 151 C 136 165 110 174 82 176 C 55 178 26 172 10 157 C -4 141 -2 116 8 94 C 18 72 38 58 48 42 C 61 24 58 15 56 0 Z"
    mask = a.node("vector", view, 30 + 500 / 1080 * 676, 113 + 483 / 720 * 450.6667,
           102, 112, "Mask/Vase region", path=data, fill=fill, stroke=C["Accent"], strokeWeight=1.3)
    a.commands.append({"command":"node.set","params":{"ids":[{"$ref":mask}],"props":{
        "x":30+500/1080*676,"y":113+483/720*450.6667,"width":102,"height":112}}})
    if label: a.chip(view, 372, 62, "已涂抹 · 花瓶区域", C["Surface"], C["Accent"], 180, h=27)


def image_view(a, mode="image"):
    p, q, view, photo, ai = image_shell(a, mode)
    if mode == "image":
        a.text(q, 16, 17, "图片信息", 15, bold=True)
        for i, (k, v) in enumerate([("尺寸", "1080 × 720 px"), ("格式", "JPEG"), ("色彩空间", "sRGB"), ("当前版本", "r3 · 已保存")]):
            a.text(q, 16, 67 + i * 44, k, 11.5, C["Muted"])
            a.text(q, 91, 67 + i * 44, v, 11.5)
        a.line(q, 15, 254, 210)
        a.text(q, 16, 276, "快速处理", 12, C["Muted"], bold=True)
        for i, (label, icon, dest) in enumerate([("裁剪与旋转", "crop", "crop"), ("光线与色彩", "sliders", "adjust"), ("局部重绘", "edit", "mask"), ("转换格式", "download", "convert")]):
            a.button(q, 13, 315 + i * 48, label, 214, icon=icon, target=dest)
        a.text(q, 16, 548, "视图与原图独立保存，\n切换标签后继续工作。", 11.5, C["Muted"], width=208, line=25)
    elif mode == "crop":
        a.text(q, 16, 17, "裁剪与旋转", 15, bold=True)
        field(a, q, 62, "裁剪比例", "3 : 2    ˅")
        field(a, q, 147, "图像尺寸", "1080  ×  720 px")
        a.text(q, 17, 236, "☑ 锁定宽高比例", 11.5, C["Muted"])
        a.line(q, 15, 279, 210)
        a.text(q, 16, 301, "旋转与翻转", 12, bold=True)
        for i, (icon, label) in enumerate([("undo", "左转"), ("refresh", "右转"), ("back", "水平"), ("right", "垂直")]):
            a.icon(q, 22 + i * 55, 347, icon, 19)
            a.text(q, 19 + i * 55, 379, label, 10.5, C["Muted"])
        a.button(q, 13, 548, "应用编辑", 214, "primary", icon="check", target="image")
        a.button(q, 13, 592, "重置裁剪", 214, target="crop", h=32)
        a.rect(view, 88, 151, 558, 371, "none", 0, "Crop selection", C["Surface"], strokeWeight=2)
        for frac in [1 / 3, 2 / 3]:
            a.line(view, 88 + 558 * frac, 151, 0, "#FFFFFF99", h=371)
            a.line(view, 88, 151 + 371 * frac, 558, "#FFFFFF99")
        for x, y in [(84,147),(642,147),(84,518),(642,518)]:
            a.rect(view, x, y, 8, 8, C["Surface"], 1)
    elif mode == "adjust":
        a.text(q, 16, 17, "光线与色彩", 15, bold=True)
        for i, (label, value, valuep) in enumerate([("曝光", "+0.2", .58), ("对比度", "+8", .55), ("高光", "−12", .43), ("阴影", "+6", .54), ("色温", "+4", .53), ("饱和度", "0", .5)]):
            slider(a, q, 70 + i * 68, label, value, valuep)
        a.button(q, 13, 548, "应用编辑", 214, "primary", icon="check", target="image")
        a.button(q, 13, 592, "重置调整", 214, target="adjust", h=32)
        a.chip(view, 24, 59, "调整预览", C["Surface"], C["Accent"], 122, "sliders")
    elif mode in ("mask", "progress"):
        vase_mask(a, view)
        a.text(q, 16, 17, "局部重绘", 15, bold=True)
        a.chip(q, 14, 58, "只修改涂抹区域", C["AccentSoft"], C["Accent"], 211, h=30)
        a.text(q, 16, 111, "画笔与蒙版", 12, bold=True)
        slider(a, q, 151, "画笔大小", "48 px", .38)
        slider(a, q, 222, "边缘羽化", "8 px", .3)
        a.text(q, 16, 295, "画笔    擦除    撤销    清空", 11.5, C["Muted"])
        a.line(q, 15, 333, 210)
        a.text(q, 16, 353, "处理说明", 12, bold=True)
        a.text(q, 16, 391, "将花瓶改为鼠尾草绿釉，\n保留瓶型、花纹与反光。", 12, width=208, line=25)
        a.text(q, 16, 469, "图像模型   自动选择\n协作数量   −   2   +", 11.5, C["Muted"], width=208, line=29)
        a.button(q, 13, 562, "取消生成" if mode == "progress" else "生成候选", 214,
                 "secondary" if mode == "progress" else "primary", icon="close" if mode == "progress" else "edit",
                 target="mask" if mode == "progress" else "progress")
        if mode == "progress":
            a.chip(view, 24, 59, "正在生成 · 任务可在后台继续", C["Surface"], C["Accent"], 314, "refresh")
            a.chip(view, 373, 351, "Image Agent", C["AccentSoft"], C["Accent"], 142, h=26)
            a.commands.append({"command":"instance.setProperties","params":{"ids":[{"$ref":ai}],"properties":{
                "Reply":"正在生成局部候选。你可以切换到\n文档或表格，任务会继续执行。",
                "TaskFirst":"已完成：读取原图与蒙版","TaskSecond":"进行中：生成候选"}}})
            a.button(p, 809, 789, "查看候选", 199, "primary", icon="right", target="compare")
    elif mode == "compare":
        # Two registered images share a viewport and exact scale; the right half is clipped.
        right = a.frame(view, 368, 113, 338, 450.6667, "Candidate comparison clip", radius=0, clip=True)
        image(a, right, -338, 0, 676, 450.6667, CANDIDATE, "Candidate demo / same viewport")
        a.line(view, 368, 113, 0, C["Surface"], h=450.6667)
        a.rect(view, 355, 316, 26, 36, C["Surface"], 13, "Comparison slider handle")
        a.text(view, 361, 323, "↔", 13, C["Accent"], family="Inter")
        a.chip(view, 45, 127, "原图", C["Surface"], C["Muted"], 64, h=25)
        a.chip(view, 616, 127, "候选", C["Surface"], C["Accent"], 70, h=25)
        a.text(q, 16, 17, "候选对比", 15, bold=True)
        a.chip(q, 14, 59, "候选 1 · 待应用", C["AccentSoft"], C["Accent"], 211, h=29)
        a.text(q, 16, 112, "局部变化", 12, bold=True)
        a.text(q, 16, 149, "花瓶呈现绿色釉面。\n人物、桌面与背景保留。", 12, width=207, line=25)
        a.text(q, 16, 240, "☐ 查看涂抹蒙版", 12, C["Muted"])
        a.text(q, 16, 291, "来源版本  r3\n当前版本  r3\n结果        尚未应用", 11.5, C["Muted"], line=30, width=208)
        a.button(q, 13, 501, "继续局部重绘", 214, icon="edit", target="mask")
        a.button(q, 13, 548, "应用候选版本", 214, "primary", icon="check", target="image")
        a.button(q, 13, 592, "丢弃候选", 214, target="mask", h=32)
    elif mode in ("convert", "png", "jpeg", "done"):
        a.text(q, 16, 17, "转换完成" if mode == "done" else "格式转换与导出", 15, bold=True)
        if mode == "done":
            a.chip(q, 14, 62, "新副本已就绪", C["Sage"], C["SageInk"], 211, "check", h=35)
            a.text(q, 16, 127, "ceramic-portrait.webp", 12.5, bold=True, width=207, family="Inter")
            a.text(q, 16, 171, "1080 × 720 px\nWebP · 另存副本\n原始图片继续保留", 12, C["Muted"], width=207, line=30)
            a.button(q, 13, 315, "下载副本", 214, "primary", icon="download")
            a.button(q, 13, 363, "在新标签打开", 214, icon="right", target="image")
            a.button(q, 13, 413, "继续转换", 214, target="convert")
        else:
            field(a, q, 63, "转换来源", "当前编辑版本   ˅")
            a.text(q, 16, 153, "目标格式", 11.5, C["Muted"])
            for i, fmt in enumerate(["PNG", "JPEG", "WebP"]):
                selected = (mode == "png" and i == 0) or (mode == "jpeg" and i == 1) or (mode == "convert" and i == 2)
                a.chip(q, 14 + i * 73, 186, fmt, C["AccentSoft"] if selected else C["Navigation"],
                       C["Accent"] if selected else C["Muted"], 66, h=29)
                a.hit(q, 14 + i * 73, 186, 66, 29, ["png","jpeg","convert"][i], "转换格式/" + fmt)
            field(a, q, 244, "输出尺寸", "1080  ×  720 px")
            if mode == "png":
                a.text(q, 16, 334, "PNG 无损输出", 12, bold=True)
                a.text(q, 16, 368, "保留透明区域，无需画质设置。", 11, C["Muted"], width=207)
            else:
                slider(a, q, 334, "画质", "90%", .9)
            if mode == "jpeg":
                a.text(q, 16, 415, "透明区域填充", 11.5, C["Muted"])
                a.rect(q, 16, 451, 25, 25, C["Surface"], 5, stroke=C["Border"])
                a.text(q, 51, 452, "白色  #FFFFFF", 11.5)
                a.text(q, 16, 490, "JPEG 使用背景色填充透明区域。", 10.5, C["Muted"], width=207)
            else:
                a.text(q, 16, 421, "☑ 保留透明区域\n☑ 锁定宽高比例", 11.5, C["Muted"], width=207, line=31)
            a.button(q, 13, 562, "转换为副本", 214, "primary", icon="download", target="done")
            a.text(q, 16, 609, "实际大小在编码完成后显示。", 10.5, C["Muted"])
    elif mode == "history":
        a.text(q, 16, 17, "版本历史", 15, bold=True)
        for i, (title, desc) in enumerate([("r3 · 当前版本", "色彩调整 · 今天 10:24"), ("r2 · 裁剪旋转", "今天 10:18"), ("r1 · 导入图片", "今天 09:50"), ("r0 · 原图", "源文件保留")]):
            box = a.frame(q, 12, 66 + i * 97, 216, 82, "Image revision/" + title,
                          C["AccentSoft"] if i == 0 else C["Stage"], radius=11)
            a.text(box, 13, 11, title, 12, bold=i == 0)
            a.text(box, 13, 43, desc, 10.5, C["Muted"])
        a.button(q, 13, 504, "与当前版本对比", 214, target="compare")
        a.button(q, 13, 552, "恢复为新版本", 214, "primary", icon="clock", target="image")
    if mode not in ("progress",):
        a.text(p, 25, 802, "原图保留 · 编辑、任务与导出分别保存", 11, C["Muted"])
        a.button(p, 831, 786, "放入白板", 177, icon="board", target="board")


def focus(a):
    p = a.frame(a.root, 12, 12, 1576, 976, "Focused image workspace", C["Stage"], C["Border"], radius=26)
    a.text(p, 25, 20, "ceramic-portrait.jpg", 15, bold=True, family="Inter")
    a.button(p, 1304, 15, "退出专注", 117, icon="back", target="image")
    a.button(p, 1433, 15, "全局 AI", 118, icon="chat", target="mask")
    image(a, p, 228, 100, 1120, 746.6667)
    a.text(p, 25, 932, "−    100%    +      适合窗口", 12, C["Muted"])
    a.text(p, 1182, 932, "当前版本 r3 · 草稿已保留", 11.5, C["Muted"])


def mobile(a):
    p = a.root
    a.text(p, 22, 15, "9:41", 13, bold=True, family="Inter")
    a.text(p, 301, 15, "5G  ▰", 12, C["Muted"], family="Inter")
    a.icon(p, 17, 61, "back", 18)
    a.text(p, 48, 55, "ceramic-portrait.jpg", 14, bold=True, family="Inter")
    a.icon(p, 351, 62, "more", 17)
    a.text(p, 20, 105, "裁剪     色彩     局部重绘     导出", 12, C["Muted"])
    image(a, p, 12, 166, 366, 244)
    a.text(p, 21, 429, "58%     适合窗口", 11.5, C["Muted"])
    a.icon(p, 344, 435, "expand", 16)
    panel = a.frame(p, 12, 479, 366, 346, "Mobile / Global AI drawer", C["Surface"], C["Border"], radius=16)
    a.rect(panel, 160, 9, 46, 4, C["Border"], 2)
    a.star(panel, 17, 30, 22)
    a.text(panel, 51, 27, "全局 AI", 16, bold=True)
    a.chip(panel, 17, 78, "当前图片 · 花瓶区域", C["AccentSoft"], C["Accent"], 250, h=28)
    a.text(panel, 17, 129, "先生成候选，再对比和应用。\n切换资料后，对话与任务继续保留。", 13, width=330, line=26)
    a.frame(panel, 13, 207, 340, 78, "Mobile AI composer", C["Stage"], C["Border"], radius=16)
    a.text(panel, 26, 221, "描述想调整的效果…", 12.5, C["Faint"])
    a.button(panel, 228, 299, "生成候选", 125, "primary", target="progress")
    a.text(panel, 17, 307, "涂抹区域已保留", 11, C["Muted"])


def library(a):
    p, _ = shell(a, "library", "我的工作台")
    a.text(p, 32, 29, "今天，从哪份资料开始？", 27, bold=True)
    a.text(p, 33, 80, "文字、表格、图片与白板，在同一个工作空间中继续。", 13, C["Muted"])
    a.button(p, 827, 28, "导入文件", 164, icon="plus", target="insert")
    a.frame(p, 29, 131, 964, 43, "Library search", C["Surface"], C["Border"], radius=12)
    a.icon(p, 44, 144, "search", 17)
    a.text(p, 76, 141, "搜索文件名、内容或最近的 AI 任务", 12.5, C["Faint"])
    a.text(p, 32, 204, "最近使用", 14, bold=True)
    entries = [("word", "doc", "产品发布方案.docx", "文字 · 已保存"),
               ("excel", "sheet", "发布预算.xlsx", "表格 · 已保存"),
               ("image", "image", "ceramic-portrait.jpg", "图片 · 可继续编辑"),
               ("board", "board", "发布筹备白板", "白板 · 已关联 2 份资料"),
               ("ppt", "ppt", "发布汇报.pptx", "演示 · 共 6 页"),
               ("pdf", "pdf", "发布手册.pdf", "PDF · 阅读与批注")]
    for i, (key, icon, name, desc) in enumerate(entries):
        x, y = 29 + (i % 3) * 326, 248 + (i // 3) * 245
        q = a.frame(p, x, y, 310, 225, "Library card/" + key, C["Surface"], C["Border"], radius=16)
        if key == "image": image(a, q, 0, 0, 310, 141, PHOTO)
        else:
            a.rect(q, 12, 12, 286, 119, C["AccentSoft"] if key != "excel" else C["Sage"], 11)
            a.icon(q, 130, 47, icon, 34, C["Accent"] if key != "excel" else C["SageInk"])
        a.text(q, 15, 151, name, 12.5, bold=True, width=281, family="Inter" if key == "image" else bd.FONT)
        a.text(q, 15, 185, desc, 11, C["Muted"])
        a.hit(q, 0, 0, 310, 225, key, "工作台/" + name)
    a.text(p, 33, 771, "支持文字、表格、演示、PDF、图片、Markdown、HTML 与纯文本资料。", 11.5, C["Muted"], width=948)


def ppt(a):
    p, _ = shell(a, "ppt", "发布汇报.pptx", "第 2 页 · 发布节奏")
    titlebar(a, p, "发布汇报.pptx", "ppt", "自动保存已开启")
    a.text(p, 25, 78, "开始     插入     设计     切换     动画     放映     视图", 12.5, C["Muted"])
    a.line(p, 23, 113, 978)
    a.text(p, 25, 131, "新建幻灯片   ˅      布局   ˅      文本框      形状      图片      对齐", 12)
    a.line(p, 23, 172, 978)
    for i in range(4):
        q = a.frame(p, 17, 196 + i * 122, 142, 96, "Slide thumbnail", C["Surface"],
                    C["Accent"] if i == 1 else C["Border"], radius=8)
        a.text(q, 11, 12, f"0{i+1}", 10, C["Muted"], family="Inter")
        a.rect(q, 13, 39, 114, 6, "#D7E2F0", 2)
        a.rect(q, 13, 56, 83, 4, C["Border"], 2)
    canvas = a.frame(p, 184, 220, 621, 350, "Slide canvas / 16:9", C["Surface"], C["Border"], radius=0)
    a.text(canvas, 36, 28, "PRODUCT LAUNCH", 11, C["Accent"], family="Inter")
    a.text(canvas, 36, 75, "从想法，到第一次成功体验。", 25, bold=True)
    for i, (title, sub) in enumerate([("预热", "邀请与反馈"), ("发布", "开放与支持"), ("跟进", "复盘与迭代")]):
        q = a.frame(canvas, 36 + i * 185, 175, 168, 117, "Slide shape/" + title, C["AccentSoft"], radius=12)
        a.text(q, 16, 15, title, 17, bold=True)
        a.text(q, 16, 64, sub, 12, C["Muted"])
    props = a.frame(p, 825, 191, 181, 499, "Slide properties", C["Surface"], C["Border"], radius=14)
    a.text(props, 15, 16, "形状属性", 13.5, bold=True)
    for i, (title, val) in enumerate([("填充", "浅蓝"), ("边框", "无"), ("圆角", "12 px"), ("排列", "对齐与分布")]):
        a.text(props, 15, 69 + i * 76, title, 11.5, C["Muted"])
        a.text(props, 15, 98 + i * 76, val, 12.5)
    a.frame(p, 184, 607, 621, 111, "Speaker notes", C["Surface"], C["Border"], radius=12)
    a.text(p, 201, 623, "演讲备注", 11.5, C["Muted"])
    a.text(p, 201, 655, "强调三个阶段之间的交付关系。", 13)
    a.text(p, 23, 816, "第 2 页 / 共 6 页       −    80%    +", 11.5, C["Muted"])
    a.button(p, 845, 779, "放映", 160, "primary", icon="ppt", target="ppt")


def pdf(a):
    p, _ = shell(a, "pdf", "发布手册.pdf", "第 2 页 · 体验指引")
    titlebar(a, p, "发布手册.pdf", "pdf", "阅读与批注")
    a.text(p, 25, 79, "选择文字      高亮      下划线      批注      查找      适合页宽", 12, C["Muted"])
    a.line(p, 23, 113, 978)
    for i in range(4):
        q = a.frame(p, 22, 140 + i * 145, 117, 125, "PDF page thumbnail", C["Surface"], C["Accent"] if i == 1 else C["Border"], radius=7)
        a.text(q, 12, 13, str(i + 1), 10, C["Muted"])
        for j in range(5): a.rect(q, 14, 45 + j * 11, 87, 3, C["Border"], 1)
    page = a.frame(p, 164, 137, 600, 642, "PDF page / Preview", C["Surface"], C["Border"], radius=8)
    a.text(page, 41, 31, "产品发布 · 用户体验指引", 24, bold=True)
    a.text(page, 41, 99, "01  完成第一次体验", 18, bold=True)
    lines = ["使用邀请链接进入产品，并完成账号设置。", "选择与你的工作最相关的使用场景。", "按照引导完成第一个任务，并保存结果。", "遇到问题时，可以通过反馈入口联系我们。"]
    for i, text in enumerate(lines):
        if i == 2: a.rect(page, 35, 145 + i * 58, 514, 30, "#F5EBC6", 2)
        a.text(page, 42, 149 + i * 58, text, 13, width=510)
    a.text(page, 41, 442, "02  提交反馈", 18, bold=True)
    a.text(page, 41, 489, "描述使用场景与遇到的问题，并附上相关截图。", 13, width=510)
    comments = a.frame(p, 782, 137, 224, 642, "PDF annotations", C["Navigation"], radius=14)
    a.text(comments, 15, 16, "批注", 14, bold=True)
    q = a.frame(comments, 11, 69, 202, 161, "PDF comment", C["Surface"], C["Border"], radius=12)
    a.text(q, 13, 12, "林晓 · 第 2 页", 12, bold=True)
    a.text(q, 13, 49, "这里补充一张操作示例，\n帮助用户确认完成结果。", 12, width=175, line=26)
    a.text(q, 13, 124, "回复     解决", 11, C["Accent"])
    a.text(p, 24, 816, "第 2 页 / 共 8 页     只读正文 · 可添加批注", 11.5, C["Muted"])


def find_replace(a, is_excel=False):
    active = "excel" if is_excel else "word"
    p, _ = shell(a, active, "发布预算.xlsx" if is_excel else "产品发布方案.docx")
    titlebar(a, p, "发布预算.xlsx" if is_excel else "产品发布方案.docx", "sheet" if is_excel else "doc")
    ribbon(a, p, active)
    panel = a.frame(p, 18, 207, 266, 573, "Find and replace", C["Surface"], C["Border"], radius=14)
    a.text(panel, 16, 15, "查找与替换", 15, bold=True)
    field(a, panel, 66, "查找内容", "内容制作" if is_excel else "发布", 236)
    field(a, panel, 154, "替换为", "素材制作" if is_excel else "产品发布", 236)
    a.text(panel, 16, 248, "☐ 区分大小写    ☐ 全字匹配", 11, C["Muted"], width=234)
    a.text(panel, 16, 298, "找到 1 处" if is_excel else "找到 3 处", 12, C["Accent"])
    for i in range(1 if is_excel else 3):
        q = a.frame(panel, 13, 340+i*45, 240, 36, "Find result", C["AccentSoft"] if i == 0 else C["Stage"], radius=8)
        a.text(q, 11, 8, "预算!B3 · 内容制作" if is_excel else ["第 1 页 · 产品发布方案", "第 2 页 · 发布节奏", "第 3 页 · 发布分工"][i], 11.5)
    a.button(panel, 13, 502, "替换当前", 111, target=active)
    a.button(panel, 134, 502, "全部替换", 119, "primary", target=active)
    page = a.frame(p, 304, 207, 699, 573, "Find / Source preview", C["Surface"], C["Border"], radius=12)
    a.text(page, 34, 31, "发布预算" if is_excel else "产品发布方案", 27, bold=True)
    if is_excel:
        bd.table(a, page, 27, 122, [160,102,70,130,142], row_h=46, selected=True, size=12)
        a.text(page, 34, 462, "已定位到预算!B3，替换前可逐项核对。", 12, C["Muted"])
    else:
        a.text(page, 34, 104, "02  发布节奏", 20, bold=True)
        a.rect(page, 30, 159, 638, 68, C["AccentSoft"], 6)
        a.text(page, 39, 169, "发布前，邀请首批用户并收集核心场景反馈。\n发布当日，同步渠道内容与用户支持。", 13, width=610, line=27)
        a.text(page, 35, 286, "03  团队分工", 20, bold=True)
        a.text(page, 35, 339, "明确每个阶段的负责人、交付内容和预算。", 13, width=610)


BUILDERS = [
    ("library", "10 · 统一工作台 · 文字表格图片", library),
    ("word", "11 · 文字文档 · 常用编辑工具", word),
    ("review", "12 · 文字审阅 · 批注与修订", lambda a: word(a, True)),
    ("excel", "13 · Excel · 常用编辑与公式", excel),
    ("data", "14 · Excel · 筛选与图表", lambda a: excel(a, True)),
    ("image", "15 · 图片预览 · 信息与快捷处理", image_view),
    ("crop", "16 · 图片 · 裁剪旋转与尺寸", lambda a: image_view(a, "crop")),
    ("adjust", "17 · 图片 · 光线与色彩", lambda a: image_view(a, "adjust")),
    ("mask", "18 · 图片 · 涂抹与局部重绘", lambda a: image_view(a, "mask")),
    ("progress", "19 · 图片 · 全局 AI 后台任务", lambda a: image_view(a, "progress")),
    ("compare", "20 · 图片 · 原图与候选对比", lambda a: image_view(a, "compare")),
    ("convert", "21 · 图片 · WebP 转换与导出", lambda a: image_view(a, "convert")),
    ("jpeg", "22 · 图片 · JPEG 背景填充", lambda a: image_view(a, "jpeg")),
    ("done", "23 · 图片 · 转换完成与副本", lambda a: image_view(a, "done")),
    ("history", "24 · 图片 · 版本记录与恢复", lambda a: image_view(a, "history")),
    ("focus", "25 · 图片 · 专注与面板收起", focus),
    ("mobile", "26 · 手机 · 图片与全局 AI", mobile),
    ("ppt", "27 · 演示 · 幻灯片与属性", ppt),
    ("pdf", "28 · PDF · 阅读高亮与批注", pdf),
    ("find", "29 · 文字 · 查找与替换", find_replace),
    ("excel_find", "30 · Excel · 查找与替换", lambda a: find_replace(a, True)),
    ("png", "31 · 图片 · PNG 无损透明导出", lambda a: image_view(a, "png")),
]


def migrate_palette(m, variables):
    for var in variables["variables"]:
        if var["name"] in C: m.command("variable.set", variable=var["id"], value=C[var["name"]])
    m.command("variable.renameCollection", collection=variables["collections"][0]["id"], name="OfficeCLI / Neutral blue")
    snapshot = m.call("inspect_document", {"allPages":True,"depth":10,"maxBytes":5000000,
        "fields":["name","type","characters","fills","strokes","boundVariables","interactions","x","y","width","height"]})
    patch = []
    literal = {**{v:C[k] for k,v in OLD.items()}, "#DEDAD0":"#DCE4EE","#EDF1E7":C["AccentSoft"],
               "#F0F3EB":"#F0F4FA","#D8DFCC":"#D9E5F2","#E4D5C7":"#E3E8F0","#D6CFBD":"#D8E2EF"}
    for page in snapshot["pages"]:
        m.command("page.select", id=page["id"])
        m.command("page.setBackground", color="#DCE3ED")
        for n in walk(page, True):
            props = {}
            for field, key in [("fills","fill"),("strokes","stroke")]:
                paints = n.get(field, [])
                if key in n.get("boundVariables", {}): continue
                if len(paints) == 1 and paints[0].get("type") == "solid" and paints[0].get("color") in literal:
                    # Preserve transparent prototype hotspots.
                    if paints[0].get("opacity", 1) < .1: continue
                    props[key] = literal[paints[0]["color"]]
            text = n.get("characters", "")
            if text in literal: props["characters"] = literal[text]
            if text == "01  暖白底色，克制的层次": props["characters"] = "01  浅灰白底色，清晰的层次"
            if "资源引用与视图 · Claude 风格方向" in text: props["characters"] = "统一办公工作空间 · 浅灰白与低饱和蓝"
            if n.get("name") == "Workspace navigation": props["fill"] = {"$var":"VariableID:2"}
            if props: patch.append({"command":"node.set","params":{"ids":[n["id"]],"props":props}})
    m.call("batch", {"label":"V2 / Whole workspace palette", "commands":patch})
    return snapshot


def main():
    if NATIVE.exists() and "--rebuild" not in sys.argv: raise SystemExit("V2 exists; use --rebuild explicitly to regenerate.")
    (OUT/"previews").mkdir(parents=True, exist_ok=True)
    m = fc.FigCraft()
    try:
        m.call("open_file", {"path":str(SOURCE)})
        m.call("save_file", {"path":str(NATIVE)})
        m.command("file.rename", name="OfficeCLI · 统一办公与全局 AI · V2")
        m.command("file.saveVersion", name="V1 · 暖色资源白板", description="Preserved before neutral-blue office capability expansion.")
        variables = m.command("variable.list")
        bd.COLOR_VARIABLES.clear()
        for v in variables["variables"]:
            if v["name"] in C: bd.COLOR_VARIABLES[C[v["name"]]] = v["id"]
        snapshot = migrate_palette(m, variables)
        ai = m.call("get_node", {"id":AI_ID,"depth":4,"fields":["name","type","characters"]})
        nodes = list(walk(ai))
        for prop, text in [
            ("Prompt","结合发布方案和预算，\n帮我检查上线准备。"),
            ("TaskTitle","发布准备检查"), ("TaskFirst","已读取方案 · 第 2 节"),
            ("TaskSecond","已引用预算 · B2:F7"), ("Suggestion","继续此对话"),
            ("NextStep","先核对发布节奏，再检查对应预算。"), ("TaskStatus","进行中")]:
            node = next(n for n in nodes if n.get("characters") == text)
            m.command("component.addProperty", id=AI_ID, name=prop, type="text", layer=node["id"])
        task_icon = next(n for n in nodes if n.get("name") == "Icon/sheet")
        m.call("set_properties", {"ids":[task_icon["id"]],"props":{"path":bd.ICONS["clock"],"width":13,"height":13}})
        original = json.loads((PREVIOUS/"manifest.json").read_text())
        page = original["screens"][0]["page"]
        m.command("page.select", id=page)
        m.command("page.rename", id=page, name="01 · 统一办公与资源白板")
        boards = []
        for i,(key,name,builder) in enumerate(BUILDERS):
            a = A(key,name,(i%2)*1720,4480+(i//2)*1120,390 if key=="mobile" else 1600,844 if key=="mobile" else 1000)
            builder(a)
            a.submit(m)
            boards.append(a)
            print("Created "+key, flush=True)
        mapping = {s["key"]:s["id"] for s in original["screens"]}
        mapping.update({a.key:a.frame_id for a in boards})
        mapping["doc_edit"] = mapping["word"]
        mapping["sheet_edit"] = mapping["excel"]
        navigation_patches = []
        deleted_navigation_ids = set()
        for source in original["screens"]:
            root = m.call("get_node", {"id":source["id"],"depth":1,"fields":["name","type"]})
            old_nav = next(n for n in root.get("children",[]) if n.get("name") == "Workspace navigation")
            removed = m.call("get_node", {"id":old_nav["id"],"depth":5,"fields":["name","type"]})
            deleted_navigation_ids.update(n["id"] for n in walk(removed))
            m.command("edit.delete", ids=[old_nav["id"]])
            patch = A("nav_"+source["key"],"Navigation consistency")
            patch.commands = []
            patch.root = source["id"]
            active = "word" if source["key"] == "doc_edit" else "excel" if source["key"] in ("range","sheet_edit") else "board"
            navigation(patch, active)
            for command in patch.commands:
                props = command["params"].get("props",{})
                for field in ("fill","stroke"):
                    if isinstance(props.get(field),str) and props[field] in bd.COLOR_VARIABLES:
                        props[field] = {"$var":bd.COLOR_VARIABLES[props[field]]}
            result = m.call("batch", {"label":"V2 / Navigation "+source["key"],"commands":patch.commands})
            patch.ids = {c["as"]:v["id"] for c,v in zip(patch.commands,result) if "id" in v}
            navigation_patches.append(patch)
        # Existing preview/edit buttons now enter the complete office editors.
        edits = []
        for pg in snapshot["pages"]:
            for n in walk(pg, True):
                if n["id"] in deleted_navigation_ids: continue
                for index, interaction in enumerate(n.get("interactions",[])):
                    text=json.dumps(interaction)
                    destination = None
                    for old,target in [(697,"word"),(1425,"excel")]:
                        if str(old) in text: destination=mapping[target]
                    if destination:
                        edits.append({"command":"proto.interaction.set","params":{"id":n["id"],"index":index,
                            "action":{"type":"navigate","dest":destination}}})
        if edits: m.call("batch", {"label":"V2 / Full office editor entry points","commands":edits})
        interactions = []
        for a in boards + navigation_patches:
            steps = []
            for alias,target,label in a.hotspots:
                steps.append({"command":"proto.interaction.add","params":{"id":a.ids[alias],"dest":mapping[target],
                    "trigger":{"type":"onClick"},"transition":{"type":"dissolve"},"durationMs":160}})
                interactions.append({"screen":a.key,"target":target,"label":label})
            if steps: m.call("batch", {"label":"V2 / Prototype "+a.key,"commands":steps})
        export_state = m.command("variable.createCollection", name="Prototype / Export result")
        file_var = m.command("variable.create", collection=export_state["id"], name="ExportFilename", type="string", value="ceramic-portrait.webp")["id"]
        info_var = m.command("variable.create", collection=export_state["id"], name="ExportDetails", type="string", value="1080 × 720 px\nWebP · 另存副本\n原始图片继续保留")["id"]
        done_tree = m.call("get_node", {"id":mapping["done"],"depth":7,"fields":["name","type","characters"]})
        filename = next(n for n in walk(done_tree) if n.get("characters") == "ceramic-portrait.webp")
        details = next(n for n in walk(done_tree) if n.get("characters","").startswith("1080 × 720 px\nWebP"))
        m.command("variable.bind", ids=[filename["id"]], field="characters", variable=file_var)
        m.command("variable.bind", ids=[details["id"]], field="characters", variable=info_var)
        for key, fmt, ext in [("convert","WebP","webp"),("jpeg","JPEG","jpg"),("png","PNG","png")]:
            screen = next(a for a in boards if a.key == key)
            submit = screen.ids[screen.aliases["Button/转换为副本"]]
            m.command("proto.interaction.clear", ids=[submit])
            m.command("proto.interaction.add", id=submit, actions=[
                {"type":"setVariable","variable":file_var,"value":"ceramic-portrait."+ext},
                {"type":"setVariable","variable":info_var,"value":"1080 × 720 px\n"+fmt+" · 另存副本\n原始图片继续保留"},
                {"type":"navigate","dest":mapping["done"]}])
        m.command("proto.flow.add", start=mapping["library"], name="统一办公 · 浅灰白与低饱和蓝")
        m.command("proto.settings", width=1600, height=1000, background=C["Canvas"])
        m.call("select", {"ids":[mapping["library"]]})
        m.call("save_file", {"path":str(NATIVE)})
        screens=[]
        for s in original["screens"]:
            path=OUT/"previews"/Path(s["preview"]).name
            m.call("export", {"ids":[s["id"]],"format":"png","scale":1,"path":str(path)})
            screens.append({**s,"preview":str(path)})
        for i,a in enumerate(boards,10):
            path=OUT/"previews"/f"{i:02d}-{a.key}.png"
            m.call("export", {"ids":[a.frame_id],"format":"png","scale":1,"path":str(path)})
            screens.append({"key":a.key,"name":a.name,"id":a.frame_id,"page":page,"preview":str(path),
                            "width":390 if a.key=="mobile" else 1600,"height":844 if a.key=="mobile" else 1000})
        for support in original["supportingFrames"]:
            filename="00-foundations.png" if support["key"]=="foundations" else "09-states.png"
            m.call("export", {"ids":[support["id"]],"format":"png","scale":1,"path":str(OUT/"previews"/filename)})
        fonts=m.command("file.fontReport")
        manifest={"title":"OfficeCLI · 统一办公与全局 AI · V2","native":str(NATIVE),"source":str(SOURCE),
                  "palette":PALETTE,"screens":screens,"supportingFrames":original["supportingFrames"],
                  "newInteractions":interactions,"previousInteractionCount":len(original["interactions"]),
                  "candidateAsset":"Existing color-composite demonstration, not a new model result."}
        (OUT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
        (OUT/"font-report.json").write_text(json.dumps(fonts,ensure_ascii=False,indent=2))
        final=m.call("inspect_document", {"allPages":True,"depth":2,"maxBytes":5000000,
                   "fields":["name","type","width","height","cornerRadius","mainComponent","interactions"]})
        (OUT/"inspection.json").write_text(json.dumps(final,ensure_ascii=False,indent=2))
        verification={"nativeBytes":NATIVE.stat().st_size,"nativeSHA256":hashlib.sha256(NATIVE.read_bytes()).hexdigest(),
                      "flowScreens":len(screens),"supportingFrames":2,"totalFrames":len(screens)+2,
                      "newPrototypeLinks":len(interactions),"missingFonts":fonts["missing"],
                      "allNewTargetsExist":all(l["target"] in mapping for l in interactions),
                      "sourceV1Preserved":SOURCE.exists(),"scope":"Editable design and clickable prototype; no application implementation changes."}
        (OUT/"validation.json").write_text(json.dumps(verification,ensure_ascii=False,indent=2))
        print(json.dumps(verification,ensure_ascii=False),flush=True)
    finally:
        m.close()


if __name__ == "__main__": main()
