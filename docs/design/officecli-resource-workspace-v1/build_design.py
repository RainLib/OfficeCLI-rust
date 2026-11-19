"""Author the resource workspace as editable FigCraft layers through stdio MCP."""
from __future__ import annotations

import json
import math
from pathlib import Path
from figcraft_mcp import FigCraft, ROOT, NATIVE

COLORS = {
    "Canvas": "#F4F2EB", "Navigation": "#ECE9E0", "Stage": "#FCFBF7",
    "Surface": "#FFFFFF", "Panel": "#F9F8F3", "Ink": "#302F2A",
    "Muted": "#7B786F", "Faint": "#A29D91", "Border": "#E2DED4",
    "Accent": "#C57556", "AccentSoft": "#F4E5DC", "Sage": "#E9EEE2",
    "SageInk": "#607153", "BlueSoft": "#E9EDF1", "BlueInk": "#637A89",
    "Yellow": "#F3EDDA", "Bubble": "#ECE9E0", "Dark": "#34332D",
}
C = COLORS
COLOR_VARIABLES = {}
FONT = "PingFang SC"
SX, SY, SW, SH, AX, AW = 208, 128, 1024, 860, 1244, 344
ICONS = {
    "plus": "M 0 8 H 16 M 8 0 V 16",
    "close": "M 1 1 L 15 15 M 15 1 L 1 15",
    "chevron": "M 2 5 L 8 11 L 14 5",
    "right": "M 1 8 H 15 M 9 2 L 15 8 L 9 14",
    "back": "M 15 8 H 1 M 7 2 L 1 8 L 7 14",
    "expand": "M 1 6 V 1 H 6 M 10 1 H 15 V 6 M 15 10 V 15 H 10 M 6 15 H 1 V 10",
    "search": "M 12 6 A 6 6 0 1 1 0 6 A 6 6 0 1 1 12 6 M 10 10 L 16 16",
    "doc": "M 1 0 H 10 L 15 5 V 18 H 1 Z M 10 0 V 5 H 15 M 4 9 H 11 M 4 13 H 11",
    "sheet": "M 0 0 H 18 V 18 H 0 Z M 0 6 H 18 M 6 0 V 18 M 12 6 V 18 M 0 12 H 18",
    "board": "M 0 0 H 18 V 14 H 0 Z M 9 14 V 19 M 5 19 H 13 M 4 5 H 9 M 4 9 H 14",
    "folder": "M 0 3 H 7 L 9 6 H 19 V 17 H 0 Z",
    "clock": "M 16 8 A 8 8 0 1 1 0 8 A 8 8 0 1 1 16 8 M 8 3 V 8 L 12 10",
    "check": "M 0 7 L 5 12 L 15 1",
    "link": "M 6 4 L 9 1 C 14 -4 21 4 16 9 L 13 12 M 10 12 L 7 15 C 2 20 -5 12 0 7 L 3 4 M 5 10 L 11 4",
    "pin": "M 3 0 H 13 L 11 5 L 15 10 H 1 L 5 5 Z M 8 10 V 18",
    "edit": "M 1 12 L 12 1 L 16 5 L 5 16 L 0 17 Z M 10 3 L 14 7",
    "location": "M 8 0 C 18 0 18 10 8 19 C -2 10 -2 0 8 0 Z M 11 7 A 3 3 0 1 1 5 7 A 3 3 0 1 1 11 7",
    "cursor": "M 0 0 L 4 17 L 8 11 L 14 13 Z",
    "hand": "M 3 8 V 3 C 3 0 6 0 6 3 V 8 V 1 C 6 -1 9 -1 9 2 V 8 V 2 C 9 0 12 0 12 3 V 8 V 5 C 12 2 15 3 15 5 V 12 C 15 20 5 22 2 15 L 0 10 C -1 7 1 6 3 8 Z",
    "rect": "M 0 0 H 17 V 15 H 0 Z",
    "circle": "M 16 8 A 8 8 0 1 1 0 8 A 8 8 0 1 1 16 8",
    "note": "M 0 0 H 17 V 11 L 11 17 H 0 Z M 11 17 V 11 H 17",
    "image": "M 0 0 H 18 V 16 H 0 Z M 0 13 L 6 7 L 11 12 L 14 9 L 18 13 M 14 4 H 14.1",
    "more": "M 1 8 H 1.2 M 8 8 H 8.2 M 15 8 H 15.2",
    "send": "M 8 15 V 1 M 1 8 L 8 1 L 15 8",
    "sidebar": "M 0 0 H 18 V 16 H 0 Z M 6 0 V 16",
    "chat": "M 0 0 H 18 V 13 H 7 L 2 18 V 13 H 0 Z",
    "refresh": "M 15 5 A 7 7 0 1 0 15 12 M 15 0 V 5 H 10",
}


class Artboard:
    def __init__(self, key, name, x=0, y=0, width=1600, height=1000):
        self.key, self.name = key, name
        self.commands, self.aliases, self.count = [], {}, 0
        self.root = self.node("frame", None, x, y, width, height, name,
                              fill=C["Canvas"], clip=True)
        self.hotspots = []

    def node(self, kind, parent, x, y, w, h, name, text=None, **props):
        self.count += 1
        alias = f"{self.key}_{self.count}"
        params = {"type": kind, "name": name, "x": x, "y": y, "select": False,
                  "props": props}
        if parent is not None:
            params["parent"] = {"$ref": parent} if isinstance(parent, str) else parent
        if w is not None: params["width"] = w
        if h is not None: params["height"] = h
        if text is not None: params["text"] = text
        self.commands.append({"command": "node.create", "as": alias, "params": params})
        self.aliases[name] = alias
        return alias

    def frame(self, p, x, y, w, h, name, fill=None, stroke=None, radius=16, **extra):
        props = {"cornerRadius": radius}
        if fill: props["fill"] = fill
        else: props["fill"] = "none"
        if stroke: props.update(stroke=stroke, strokeWeight=1)
        props.update(extra)
        return self.node("frame", p, x, y, w, h, name, **props)

    def rect(self, p, x, y, w, h, fill, radius=0, name="Shape", stroke=None, **extra):
        props = dict(fill=fill or "none", cornerRadius=radius)
        if stroke: props.update(stroke=stroke, strokeWeight=1)
        props.update(extra)
        return self.node("rectangle", p, x, y, w, h, name, **props)

    def text(self, p, x, y, text, size=15, color=None, width=None, bold=False,
             name=None, family=FONT, line=None):
        return self.node("text", p, x, y, width, None, name or text[:36], text=text,
                         fill=color or C["Ink"], fontFamily=family,
                         fontStyle="Bold" if bold else "Regular", fontSize=size,
                         lineHeight=line or round(size * 1.55, 1),
                         textAutoResize="height" if width else "widthAndHeight")

    def icon(self, p, x, y, kind, size=17, color=None, name=None):
        path = ICONS.get(kind, ICONS["plus"])
        return self.node("vector", p, x, y, size, size, name or f"Icon/{kind}",
                         path=path, fill="none", stroke=color or C["Muted"],
                         strokeWeight=1.55, strokeCap="round", strokeJoin="round")

    def line(self, p, x, y, w, color=None, h=0):
        return self.node("vector", p, x, y, None, None, "Divider",
                         path=f"M 0 0 L {w} {h}", fill="none",
                         stroke=color or C["Border"], strokeWeight=1)

    def chip(self, p, x, y, label, fill=None, color=None, width=None, icon=None, h=28):
        width = width or max(52, len(label) * 12 + (39 if icon else 22))
        root = self.frame(p, x, y, width, h, "Chip/" + label,
                          fill or C["AccentSoft"], radius=8)
        if icon: self.icon(root, 9, (h - 14) / 2, icon, 14, color or C["Accent"])
        self.text(root, 29 if icon else 10, (h - 19) / 2, label, 12,
                  color or C["Accent"], width=width - (35 if icon else 16), line=19)
        return root

    def button(self, p, x, y, label, width=110, kind="secondary", icon=None, target=None, h=36):
        fill, ink = (C["Dark"], C["Surface"]) if kind == "primary" else (C["Surface"], C["Ink"])
        if kind == "quiet": fill, ink = C["Stage"], C["Muted"]
        root = self.frame(p, x, y, width, h, "Button/" + label, fill,
                          None if kind != "secondary" else C["Border"], radius=10)
        if icon: self.icon(root, 12, (h - 15) / 2, icon, 15, ink)
        self.text(root, 35 if icon else 13, (h - 22) / 2, label, 13, ink,
                  width=width - (42 if icon else 20), line=22)
        if target: self.hotspots.append((root, target, label))
        return root

    def star(self, p, x, y, size=24, color=None):
        data = []
        for i in range(12):
            a = math.pi * i / 6
            data.append(f"M {12 + 3 * math.cos(a):.3f} {12 + 3 * math.sin(a):.3f} L {12 + 11 * math.cos(a):.3f} {12 + 11 * math.sin(a):.3f}")
        return self.node("vector", p, x, y, size, size, "Global AI / Mark",
                         path=" ".join(data), fill="none", stroke=color or C["Accent"],
                         strokeWeight=1.8, strokeCap="round")

    def hit(self, p, x, y, w, h, target, name):
        n = self.rect(p, x, y, w, h, "#FFFFFF01", 8, "Hotspot/" + name)
        self.hotspots.append((n, target, name))
        return n

    def submit(self, m):
        for command in self.commands:
            props = command["params"].get("props", {})
            for field in ("fill", "stroke"):
                if isinstance(props.get(field), str) and props[field] in COLOR_VARIABLES:
                    props[field] = {"$var": COLOR_VARIABLES[props[field]]}
        values = m.call("batch", {"label": self.name, "commands": self.commands})
        ids = {c["as"]: v["id"] for c, v in zip(self.commands, values) if "id" in v}
        self.ids = ids
        self.frame_id = ids[self.root]
        return ids


def sidebar(a, active="白板"):
    p = a.frame(a.root, 12, 12, 184, 976, "Workspace navigation", C["Navigation"], radius=20)
    a.star(p, 17, 19, 26)
    a.text(p, 52, 19, "OfficeCLI", 18.5, bold=True, family="Georgia")
    a.icon(p, 151, 24, "sidebar", 17)
    a.button(p, 12, 75, "新建", 160, icon="plus")
    a.icon(p, 24, 135, "search", 16)
    a.text(p, 50, 129, "搜索工作空间", 13, C["Muted"])
    a.text(p, 24, 185, "工作空间", 11, C["Muted"], bold=True)
    a.icon(p, 23, 221, "folder", 17)
    a.text(p, 50, 214, "产品发布", 14, bold=True)
    for i, (label, icon, target) in enumerate([
        ("发布筹备白板", "board", "board"),
        ("产品发布方案", "doc", "doc_edit"),
        ("发布预算", "sheet", "sheet_edit"),
    ]):
        y = 260 + i * 43
        selected = (active == "白板" and i == 0) or (active == "文档" and i == 1) or (active == "表格" and i == 2)
        if selected: a.rect(p, 12, y - 4, 160, 36, C["Stage"], 10, "Active resource")
        a.icon(p, 25, y + 5, icon, 15, C["Ink"] if selected else C["Muted"])
        a.text(p, 51, y - 1, label, 13, C["Ink"] if selected else C["Muted"])
        a.hit(p, 12, y - 4, 160, 36, target, "打开" + label)
    a.line(p, 20, 418, 144)
    a.text(p, 24, 439, "最近对话", 11, C["Muted"], bold=True)
    a.icon(p, 25, 479, "chat", 15)
    a.text(p, 50, 472, "发布准备检查", 13, C["Muted"])
    a.text(p, 50, 505, "跨白板、文档和表格继续", 10.5, C["Faint"], width=116)
    a.rect(p, 13, 784, 158, 98, C["Sage"], 14, "Workspace helper")
    a.text(p, 26, 799, "同一份资料，多处关联", 12.5, C["SageInk"], bold=True)
    a.text(p, 26, 825, "在白板中看见关系，\n在原文中继续工作。", 11.5, C["SageInk"], width=133)
    a.line(p, 20, 910, 144)
    a.rect(p, 22, 932, 28, 28, "#D6CFBD", 14, "User avatar")
    a.text(p, 30, 934, "W", 13, C["Ink"], family="Inter", bold=True)
    a.text(p, 61, 930, "我的工作空间", 12.5)


def header(a, active="白板", stage_width=SW):
    a.text(a.root, 214, 24, "产品发布", 13, C["Muted"])
    a.text(a.root, 286, 24, "/", 13, C["Faint"])
    a.text(a.root, 305, 23, "发布筹备", 14, bold=True)
    a.chip(a.root, 403, 22, "已保存", C["Sage"], C["SageInk"], 64, h=24)
    for i, (name, fill) in enumerate([("Y", "#D8DFCC"), ("L", "#E4D5C7"), ("W", "#D9DFE5")]):
        a.rect(a.root, 1274 + i * 23, 22, 30, 30, fill, 15, "Collaborator")
        a.text(a.root, 1284 + i * 23, 25, name, 11, family="Inter")
    a.button(a.root, 1374, 19, "分享", 78)
    a.button(a.root, 1462, 19, "全局 AI", 126, icon="chat", target="ai")
    tabs = [("board", "board", "筹备白板", 146), ("doc_edit", "doc", "产品发布方案", 176), ("sheet_edit", "sheet", "发布预算", 150)]
    x = 208
    for target, icon, label, width in tabs:
        selected = (active == "白板" and target == "board") or (active == "文档" and target == "doc_edit") or (active == "表格" and target == "sheet_edit")
        p = a.frame(a.root, x, 76, width, 40, "Resource tab/" + label,
                    C["Stage"] if selected else C["Canvas"],
                    C["Border"] if selected else None, radius=12)
        a.icon(p, 13, 12, icon, 15, C["Accent"] if selected else C["Muted"])
        a.text(p, 38, 8, label, 13, C["Ink"] if selected else C["Muted"])
        a.hit(p, 0, 0, width, 40, target, "切换" + label)
        x += width + 8
    a.icon(a.root, x + 9, 88, "plus", 15)


def make_ai(a, x=AX, y=76, width=AW, component=False):
    p = a.node("component" if component else "frame", a.root, x, y, width, 912,
               "Global AI / Persistent shell", fill=C["Panel"], cornerRadius=16,
               stroke=C["Border"], strokeWeight=1)
    a.star(p, 18, 21, 23)
    a.text(p, 51, 17, "全局 AI", 18, bold=True)
    a.icon(p, width - 86, 24, "clock", 16)
    a.icon(p, width - 57, 24, "plus", 16)
    a.icon(p, width - 29, 24, "expand", 15)
    a.text(p, 19, 59, "对话", 13, bold=True)
    a.text(p, 81, 59, "任务  2", 13, C["Muted"])
    a.text(p, 158, 59, "资料", 13, C["Muted"])
    a.line(p, 16, 91, width - 32)
    a.rect(p, 18, 87, 28, 2, C["Ink"], 1, "Active AI tab")
    scope = a.frame(p, 14, 106, width - 28, 111, "AI context / Persistent references",
                    C["Canvas"], radius=12)
    a.text(scope, 13, 10, "此对话的上下文", 11.5, C["Muted"])
    a.text(scope, width - 76, 10, "管理", 11.5, C["Accent"])
    current = a.text(scope, 13, 34, "当前：发布筹备白板", 12.5, width=width - 64, name="AI/currentPage")
    a.chip(scope, 12, 72, "发布方案", C["Surface"], C["Muted"], 112, "pin", h=26)
    a.chip(scope, 133, 72, "发布预算", C["Surface"], C["Muted"], 112, "pin", h=26)
    bubble = a.frame(p, 39, 243, width - 55, 83, "User / Continuing conversation", C["Bubble"], radius=16)
    a.text(bubble, 15, 13, "结合发布方案和预算，\n帮我检查上线准备。", 14, width=width - 88, line=25)
    a.star(p, 18, 353, 21)
    reply = a.text(p, 18, 390, "我已关联两份资料。切换到文档\n或表格后，我们可以继续这段对话。", 14,
                   width=width - 36, line=26, name="AI/reply")
    a.text(p, 18, 463, "先核对发布节奏，再检查对应预算。", 13, C["Muted"], width=width - 36, line=24)
    card = a.frame(p, 14, 512, width - 28, 145, "AI cross-resource task", C["Surface"], C["Border"], radius=14)
    a.text(card, 14, 12, "发布准备检查", 14, bold=True)
    a.chip(card, width - 102, 12, "进行中", C["Sage"], C["SageInk"], 60, h=23)
    a.icon(card, 15, 54, "check", 13, C["SageInk"])
    a.text(card, 38, 46, "已读取方案 · 第 2 节", 12.5, C["Muted"])
    a.icon(card, 15, 85, "sheet", 13, C["BlueInk"])
    a.text(card, 38, 77, "已引用预算 · B2:F7", 12.5, C["Muted"])
    a.line(card, 14, 112, width - 56)
    a.text(card, 15, 121, "查看任务与来源", 11, C["Accent"])
    a.text(p, 18, 692, "继续此对话", 11.5, C["Muted"])
    a.chip(p, 14, 721, "把讨论整理成方案", C["Canvas"], C["Muted"], 155, h=28)
    composer = a.frame(p, 14, 769, width - 28, 125, "Global AI / Composer",
                       C["Surface"], C["Border"], radius=16)
    sel = a.frame(composer, 11, 10, width - 50, 24, "AI/selectionPill", C["AccentSoft"], radius=7)
    selection = a.text(sel, 9, 2, "选区：预算!B2:F7", 11, C["Accent"], width=width - 75,
                       line=20, name="AI/selectionLabel")
    a.text(composer, 13, 44, "继续提问，或 @ 引用资料", 13, C["Faint"], width=width - 59)
    a.icon(composer, 15, 92, "plus", 15)
    a.text(composer, 43, 87, "添加资料", 11.5, C["Muted"])
    a.text(composer, width - 125, 87, "自动", 11.5, C["Muted"])
    a.rect(composer, width - 66, 83, 30, 30, C["Dark"], 10, "Send button")
    a.icon(composer, width - 58, 91, "send", 14, C["Surface"])
    return p, {"CurrentPage": current, "Reply": reply, "Selection": selection, "HasSelection": sel}


AI_ID = None


def shell(a, active="白板", selected=False):
    sidebar(a, active)
    header(a, active)
    stage = a.frame(a.root, SX, SY, SW, SH, "Main stage / 26px", C["Stage"], C["Border"], radius=26, clip=True)
    alias = f"{a.key}_globalAI"
    a.commands.append({"command": "instance.create", "as": alias,
                       "params": {"component": AI_ID, "x": AX, "y": 76, "parent": {"$ref": a.root}}})
    label = {"白板": "当前：发布筹备白板", "文档": "当前：产品发布方案 · 第 2 节", "表格": "当前：发布预算 · 预算"}[active]
    selection = {"doc_preview": "引用：方案 · 第 2 节", "ai": "已选：发布方案与预算区域"}.get(a.key, "选区：预算!B2:F7")
    a.commands.append({"command": "instance.setProperties", "params": {
        "ids": [{"$ref": alias}], "properties": {"CurrentPage": label, "HasSelection": selected, "Selection": selection}}})
    a.hit(a.root, AX + 270, 187, 52, 28, "ai", "管理全局上下文")
    a.hit(a.root, AX + 303, 94, 27, 28, "ai", "展开全局AI")
    return stage


def dots(a, p):
    path = []
    for x in range(24, SW - 8, 32):
        for y in range(105, SH - 40, 32):
            path.append(f"M {x} {y} h 0.1")
    a.node("vector", p, 0, 0, None, None, "Canvas dot grid", path=" ".join(path),
           fill="none", stroke="#DEDAD0", strokeWeight=1.5, strokeCap="round")


def board_chrome(a, p):
    dots(a, p)
    a.text(p, 24, 21, "发布筹备白板", 15, bold=True)
    a.icon(p, 173, 28, "chevron", 12)
    a.button(p, SW - 238, 15, "放入资料", 112, icon="plus", target="insert")
    a.button(p, SW - 116, 15, "整理", 92, icon="refresh")
    a.line(p, 21, 66, SW - 42)
    a.text(p, 34, 91, "把想法，连成下一步。", 29, bold=True)
    a.text(p, 36, 143, "讨论、方案和预算，在同一个空间里继续。", 13, C["Muted"])
    a.text(p, 24, SH - 43, "−    100%    +", 12, C["Muted"], family="Inter")
    tools = a.frame(p, 262, SH - 70, 487, 48, "Canvas tools", C["Surface"], C["Border"], radius=14,
                    effects=[{"type": "dropShadow", "color": "#302F2A0A", "offset": [0, 3], "radius": 9}])
    for i, icon in enumerate(["cursor", "hand", "rect", "circle", "right", "edit", "note", "image", "plus"]):
        if i == 0: a.rect(tools, 6, 6, 37, 36, C["AccentSoft"], 9)
        a.icon(tools, 16 + i * 51, 16, icon, 16, C["Accent"] if i == 0 else C["Muted"])
    a.frame(p, SW - 139, SH - 112, 115, 81, "Canvas minimap", C["Surface"], C["Border"], radius=10)
    a.rect(p, SW - 124, SH - 97, 35, 28, C["AccentSoft"], 3)
    a.rect(p, SW - 79, SH - 89, 39, 22, C["Sage"], 3)
    a.rect(p, SW - 109, SH - 55, 55, 9, C["Yellow"], 3)


def doc_card(a, p, x=34, y=224, selected=False):
    q = a.frame(p, x, y, 418, 352, "Resource/Document live view", C["Surface"],
                C["Accent"] if selected else C["Border"], radius=16,
                effects=[{"type": "dropShadow", "color": "#302F2A08", "offset": [0, 4], "radius": 14}])
    a.icon(q, 17, 20, "doc", 18, C["Accent"])
    a.text(q, 48, 14, "产品发布方案", 14, bold=True)
    a.chip(q, 331, 13, "实时", C["Sage"], C["SageInk"], 66, "link", h=24)
    a.line(q, 15, 58, 388)
    a.text(q, 23, 79, "02 / 发布节奏", 21, bold=True)
    a.text(q, 23, 123, "让每个阶段都有明确的目标与交付。", 12.5, C["Muted"], width=368)
    for i, (title, content) in enumerate([
        ("预热期 · 11.18—11.24", "邀请首批用户，收集核心场景反馈。"),
        ("发布日 · 11.25", "产品开放体验，同步渠道内容与支持。"),
        ("跟进期 · 11.26—12.02", "回访用户，将反馈转成下一轮计划。"),
    ]):
        yy = 169 + i * 40
        a.rect(q, 24, yy + 7, 5, 5, C["Accent"], 2)
        a.text(q, 40, yy, title, 12, bold=True)
        a.text(q, 40, yy + 19, content, 10.5, C["Muted"], width=349)
    a.line(q, 16, 299, 386)
    a.button(q, 14, 309, "预览", 83, icon="doc", target="doc_preview", h=29)
    a.button(q, 104, 309, "定位原文", 121, icon="location", target="doc_edit", h=29)
    a.button(q, 234, 309, "进入编辑", 121, icon="edit", target="doc_edit", h=29)
    a.icon(q, 378, 316, "more", 15)
    a.hit(q, 18, 71, 380, 216, "doc_preview", "打开文档预览")
    return q


TABLE = [
    ["项目", "负责人", "数量", "单价", "小计"],
    ["内容制作", "林晓", "4", "3,000", "12,000"],
    ["渠道投放", "余宁", "3", "6,000", "18,000"],
    ["用户访谈", "陈一", "8", "500", "4,000"],
    ["活动物料", "林晓", "1", "2,000", "2,000"],
    ["合计", "", "", "", "36,000"],
]


def table(a, p, x, y, widths, row_h=30, selected=False, size=11):
    for r, row in enumerate(TABLE):
        xx = x
        for c, (value, width) in enumerate(zip(row, widths)):
            fill = C["Sage"] if r == 0 else C["Panel"] if r == len(TABLE) - 1 else C["Surface"]
            a.rect(p, xx, y + r * row_h, width, row_h, fill, 0,
                   f"Cell/{r+1}:{c+1}", C["Border"])
            a.text(p, xx + 9, y + r * row_h + (row_h - size * 1.55) / 2, value,
                   size, C["SageInk"] if r == 0 else C["Ink"], width=width - 14,
                   bold=r in (0, len(TABLE) - 1))
            xx += width
    if selected:
        a.rect(p, x, y, sum(widths), row_h * len(TABLE), "none", 0,
               "Range outline", C["Accent"], strokeWeight=2)


def sheet_card(a, p, x=520, y=296, selected=False):
    if selected:
        bar = a.frame(p, x + 30, y - 49, 394, 38, "Selected resource toolbar", C["Dark"], radius=11)
        a.text(bar, 13, 9, "表格区域", 12, C["Surface"])
        a.line(bar, 82, 8, 0, "#FFFFFF35", h=22)
        a.text(bar, 96, 9, "定位原文", 12, C["Surface"])
        a.text(bar, 175, 9, "编辑", 12, C["Surface"])
        a.text(bar, 224, 9, "交给 AI", 12, C["Surface"])
        a.icon(bar, 357, 12, "more", 14, C["Surface"])
        a.hit(bar, 88, 0, 80, 38, "sheet_edit", "定位表格区域")
        a.hit(bar, 171, 0, 47, 38, "sheet_edit", "编辑表格区域")
        a.hit(bar, 220, 0, 85, 38, "ai", "将区域交给全局AI")
    q = a.frame(p, x, y, 466, 337, "Resource/Spreadsheet range live view", C["Surface"],
                C["Accent"] if selected else C["Border"], radius=16,
                effects=[{"type": "dropShadow", "color": "#302F2A08", "offset": [0, 4], "radius": 14}])
    a.icon(q, 16, 18, "sheet", 18, C["SageInk"])
    a.text(q, 47, 13, "发布预算", 14, bold=True)
    a.chip(q, 380, 13, "实时", C["Sage"], C["SageInk"], 66, "link", h=24)
    a.text(q, 17, 49, "预算 ! B2:F7", 11.5, C["Muted"], family="Inter")
    table(a, q, 16, 81, [114, 76, 54, 91, 97], row_h=29, size=10.5)
    a.text(q, 17, 265, "与原表保持关联 · 更新于刚刚", 10.5, C["Muted"])
    a.line(q, 16, 289, 432)
    a.button(q, 14, 299, "定位原表", 119, icon="location", target="sheet_edit", h=28)
    a.button(q, 142, 299, "进入编辑", 119, icon="edit", target="sheet_edit", h=28)
    a.icon(q, 425, 306, "more", 15)
    if selected:
        for xx, yy in [(0, 0), (458, 0), (0, 329), (458, 329)]:
            a.rect(q, xx, yy, 8, 8, C["Surface"], 2, "Selection handle", C["Accent"])
    a.hit(q, 14, 75, 436, 191, "sheet_edit", "打开预算原表")
    return q


def board(a, selected=False):
    p = shell(a, selected=selected)
    board_chrome(a, p)
    doc_card(a, p)
    a.node("vector", p, 459, 400, None, None, "Relationship/document to budget",
           path="M 0 0 C 38 0 22 48 59 48 M 51 41 L 59 48 L 51 55",
           fill="none", stroke=C["Faint"], strokeWeight=1.4, strokeCap="round")
    sheet_card(a, p, selected=selected)
    note = a.frame(p, 615, 174 if selected else 196, 312, 60 if selected else 76, "Discussion/Goal", C["Sage"], radius=14)
    a.text(note, 16, 10, "这次发布，我们希望…", 12, C["SageInk"], bold=True)
    a.text(note, 16, 35, "让首批用户顺利完成第一次体验。", 12, C["SageInk"])
    milestone = a.frame(p, 171, 672, 629, 79, "Discussion/Next step", C["Yellow"], radius=14)
    a.text(milestone, 19, 14, "下一步", 11, C["Muted"], bold=True)
    a.text(milestone, 19, 37, "先对齐发布节奏，再确认每项投入。", 15, bold=True)
    a.chip(milestone, 466, 24, "待团队确认", C["Stage"], C["Muted"], 142, h=28)
    if selected:
        a.chip(p, 668, 641, "已放入区域 · 6 行 × 5 列", C["Sage"], C["SageInk"], 254, "check")
    return p


def section_header(a, p, title, subtitle, icon="doc"):
    a.icon(p, 24, 24, icon, 20, C["Accent"] if icon == "doc" else C["SageInk"])
    a.text(p, 57, 18, title, 17, bold=True)
    a.text(p, 25, 69, subtitle, 13, C["Muted"], width=SW - 55)
    a.line(p, 24, 109, SW - 48)


def insert(a):
    p = shell(a)
    section_header(a, p, "把资料放到白板", "选择文档或表格区域，保留与原始资料的关联。", "link")
    lib = a.frame(p, 24, 133, 302, 624, "Resource picker / Library", C["Canvas"], radius=16)
    search = a.frame(lib, 14, 15, 274, 38, "Search resources", C["Surface"], C["Border"], radius=10)
    a.icon(search, 12, 11, "search", 15)
    a.text(search, 38, 8, "搜索可访问的资料", 12, C["Faint"])
    a.chip(lib, 14, 67, "全部", C["Dark"], C["Surface"], 59)
    a.chip(lib, 81, 67, "文档", C["Surface"], C["Muted"], 59)
    a.chip(lib, 148, 67, "表格", C["Surface"], C["Muted"], 59)
    a.text(lib, 16, 119, "产品发布", 11.5, C["Muted"], bold=True)
    for i, (title, desc, icon, target) in enumerate([
        ("产品发布方案.docx", "今天 10:24 · 可编辑", "doc", "insert"),
        ("发布预算.xlsx", "今天 10:18 · 可编辑", "sheet", "range"),
        ("用户访谈记录.docx", "昨天 16:42 · 仅查看", "doc", None),
        ("渠道内容排期.xlsx", "昨天 14:06 · 可编辑", "sheet", "range"),
    ]):
        yy = 154 + i * 86
        row = a.frame(lib, 12, yy, 278, 73, "Resource/" + title,
                      C["Surface"] if i == 0 else C["Canvas"],
                      C["Accent"] if i == 0 else None, radius=12)
        a.icon(row, 13, 16, icon, 18, C["Accent"] if icon == "doc" else C["SageInk"])
        a.text(row, 43, 10, title, 12.5, bold=i == 0, width=221)
        a.text(row, 43, 38, desc, 10.5, C["Muted"])
        if target: a.hit(row, 0, 0, 278, 73, target, "选择" + title)
    a.text(lib, 17, 557, "也可以从左侧资源列表拖入白板。", 11.5, C["Muted"], width=268)
    pre = a.frame(p, 344, 133, 656, 624, "Resource picker / Preview", C["Surface"], C["Border"], radius=16)
    a.text(pre, 22, 20, "产品发布方案.docx", 15, bold=True)
    a.chip(pre, 527, 19, "可编辑", C["Sage"], C["SageInk"], 104, h=26)
    a.rect(pre, 20, 71, 616, 43, C["Canvas"], 10)
    a.rect(pre, 164, 75, 135, 35, C["Surface"], 8)
    a.text(pre, 51, 82, "整份文档", 12.5, C["Muted"])
    a.text(pre, 183, 82, "选中片段", 12.5, bold=True)
    a.text(pre, 32, 144, "产品发布方案", 27, bold=True)
    a.text(pre, 33, 194, "从第一批用户的成功体验开始。", 14, C["Muted"])
    a.text(pre, 33, 250, "01  发布目标", 16, bold=True)
    a.text(pre, 33, 286, "通过小范围邀请验证产品核心价值，并建立清晰的反馈渠道。", 13, width=580, line=26)
    a.rect(pre, 22, 353, 612, 145, C["AccentSoft"], 12)
    a.rect(pre, 22, 365, 3, 119, C["Accent"], 1)
    a.text(pre, 38, 368, "02  发布节奏", 16, bold=True)
    a.text(pre, 38, 407, "预热、发布、跟进三个阶段，将分别关联对应的负责人、\n交付内容与预算。", 13, width=568, line=27)
    a.text(pre, 33, 533, "引用方式", 11.5, C["Muted"])
    a.chip(pre, 104, 527, "实时引用", C["Sage"], C["SageInk"], 111, "link")
    a.text(pre, 33, 574, "白板展示预览，正文继续由原文档管理。", 11.5, C["Muted"], width=570)
    a.button(p, 754, 788, "取消", 89, target="board")
    a.button(p, 855, 788, "放入白板", 145, "primary", icon="plus", target="board")


def doc_preview(a):
    p = shell(a, selected=True)
    section_header(a, p, "产品发布方案 · 预览", "来自发布筹备白板 / 产品发布方案 / 第 2 节", "doc")
    a.button(p, 756, 17, "定位原文", 119, icon="location", target="doc_edit")
    a.button(p, 887, 17, "进入编辑", 113, "primary", icon="edit", target="doc_edit")
    outline = a.frame(p, 24, 133, 189, 639, "Document preview / Outline", C["Canvas"], radius=14)
    a.text(outline, 17, 16, "文档目录", 12, C["Muted"])
    for i, label in enumerate(["01  发布目标", "02  发布节奏", "03  团队分工", "04  风险与应对"]):
        yy = 65 + i * 47
        if i == 1: a.rect(outline, 8, yy - 5, 173, 37, C["AccentSoft"], 9)
        a.text(outline, 18, yy, label, 12, C["Accent"] if i == 1 else C["Muted"], bold=i == 1)
    a.text(outline, 17, 545, "实时引用", 11.5, C["SageInk"])
    a.text(outline, 17, 571, "原文更新后，\n白板预览会同步。", 11.5, C["Muted"], width=160)
    page = a.frame(p, 236, 133, 764, 639, "Document preview / Page", C["Surface"], C["Border"], radius=14)
    a.text(page, 42, 24, "PRODUCT LAUNCH / 2026", 10.5, C["Faint"], family="Inter")
    a.text(page, 42, 65, "产品发布方案", 30, bold=True)
    a.text(page, 42, 122, "一次有准备、有反馈的产品发布。", 14, C["Muted"])
    a.line(page, 42, 174, 680)
    a.text(page, 42, 202, "02  发布节奏", 21, bold=True)
    a.chip(page, 566, 201, "白板引用位置", C["AccentSoft"], C["Accent"], 153, "location", h=27)
    a.rect(page, 31, 253, 701, 256, C["AccentSoft"], 10)
    a.rect(page, 31, 266, 3, 229, C["Accent"], 1)
    for i, (title, content) in enumerate([
        ("预热期 · 11.18—11.24", "邀请首批用户，收集核心场景反馈，准备渠道内容。"),
        ("发布日 · 11.25", "产品开放体验，完成内容上线并安排用户支持。"),
        ("跟进期 · 11.26—12.02", "回访用户，将问题、反馈和数据转成下一轮计划。"),
    ]):
        yy = 272 + i * 76
        a.text(page, 48, yy, title, 14, bold=True)
        a.text(page, 48, yy + 31, content, 12.5, width=635)
    a.text(page, 42, 541, "03  团队分工", 19, bold=True)
    a.text(page, 42, 582, "产品、内容与支持共同维护发布清单。", 13, C["Muted"], width=672)
    a.button(p, 24, 792, "返回白板", 127, icon="back", target="board")
    a.text(p, 247, 800, "第 2 节已定位 · 当前为预览", 12, C["Muted"])


def doc_edit(a):
    p = shell(a, "文档", selected=False)
    a.icon(p, 23, 23, "doc", 19, C["Accent"])
    a.text(p, 56, 16, "产品发布方案.docx", 16, bold=True)
    a.chip(p, 754, 17, "正在编辑原文", C["Sage"], C["SageInk"], 152, h=26)
    a.icon(p, 959, 25, "more", 18)
    a.line(p, 22, 63, 980)
    a.text(p, 25, 77, "正文  ˅    PingFang SC   ˅     14   ˅", 12, C["Muted"], family="Inter")
    a.text(p, 344, 76, "B     I     U     ≡     •     ↗", 14, C["Ink"], family="Inter")
    a.line(p, 22, 111, 980)
    a.text(p, 25, 139, "目录", 11.5, C["Muted"], bold=True)
    for i, label in enumerate(["发布目标", "发布节奏", "团队分工", "风险与应对"]):
        if i == 1: a.rect(p, 14, 216, 150, 36, C["AccentSoft"], 9)
        a.text(p, 30, 184 + i * 41, label, 12, C["Accent"] if i == 1 else C["Muted"])
    page = a.frame(p, 190, 134, 789, 643, "Source document / Editable page", C["Surface"], C["Border"], radius=12)
    a.text(page, 50, 30, "PRODUCT LAUNCH / 2026", 10.5, C["Faint"], family="Inter")
    a.text(page, 50, 76, "产品发布方案", 30, bold=True)
    a.text(page, 50, 137, "02  发布节奏", 21, bold=True)
    a.text(page, 50, 188, "预热期 · 11.18—11.24", 15, bold=True)
    a.rect(page, 47, 226, 672, 63, "#EDF1E7", 5, "Located source paragraph")
    a.text(page, 53, 232, "邀请首批用户，收集核心场景反馈。\n在邀请邮件中提供体验指引，并明确反馈入口。", 14, width=658, line=27)
    a.rect(page, 473, 267, 1.4, 20, C["Accent"], 0, "Editing caret")
    a.text(page, 50, 323, "发布日 · 11.25", 15, bold=True)
    a.text(page, 50, 366, "产品开放体验，同步渠道内容与用户支持。\n每个阶段的负责人和投入，统一在预算表中确认。", 14, width=665, line=28)
    a.text(page, 50, 460, "跟进期 · 11.26—12.02", 15, bold=True)
    a.text(page, 50, 503, "回访用户，将反馈转成下一轮计划。", 14, width=665)
    a.chip(page, 50, 575, "白板引用正在同步", C["Sage"], C["SageInk"], 204, "refresh", h=27)
    a.button(p, 24, 796, "返回白板", 126, icon="back", target="board")
    a.text(p, 216, 803, "已定位第 2 节 · 修改会更新原文与白板预览", 11.5, C["Muted"])
    a.text(p, 871, 803, "已自动保存", 11.5, C["SageInk"])


def spreadsheet(a, picking=False):
    p = shell(a, "表格", selected=True)
    a.icon(p, 23, 23, "sheet", 19, C["SageInk"])
    a.text(p, 55, 17, "选择表格区域" if picking else "发布预算.xlsx", 16, bold=True)
    a.chip(p, 751, 18, "实时引用" if picking else "正在编辑原表", C["Sage"], C["SageInk"], 166, h=26)
    a.line(p, 22, 63, 980)
    a.text(p, 24, 77, "文件     开始     插入     数据     公式", 12, C["Muted"])
    a.text(p, 624, 77, "￥    %     .00     ∑    筛选", 12, C["Muted"], family="Inter")
    a.line(p, 22, 110, 980)
    a.frame(p, 22, 125, 126, 34, "Name box", C["Surface"], C["Border"], radius=7)
    a.text(p, 34, 131, "B2:F7" if picking else "F3", 13, family="Inter")
    a.text(p, 165, 130, "fx", 14, C["Muted"], family="Georgia")
    a.frame(p, 202, 125, 799, 34, "Formula bar", C["Surface"], C["Border"], radius=7)
    a.text(p, 216, 131, "选中区域：预算!B2:F7" if picking else "=D3*E3", 12, C["Muted"], family="Inter")
    gx, gy, rw, cw, rh = 24, 180, 45, 132, 48
    headers = ["A", "B", "C", "D", "E", "F", "G"]
    rows = [
        ["", "产品发布预算", "", "", "", "", ""],
        ["", "项目", "负责人", "数量", "单价", "小计", "状态"],
        ["1", "内容制作", "林晓", "4", "3,000", "12,000", "已确认"],
        ["2", "渠道投放", "余宁", "3", "6,000", "18,000", "待确认"],
        ["3", "用户访谈", "陈一", "8", "500", "4,000", "已确认"],
        ["4", "活动物料", "林晓", "1", "2,000", "2,000", "已确认"],
        ["", "合计", "", "", "", "36,000", ""],
        ["", "", "", "", "", "", ""],
        ["", "", "", "", "", "", ""],
    ]
    for cc in range(8):
        x = gx if cc == 0 else gx + rw + (cc - 1) * cw
        width = rw if cc == 0 else cw
        a.rect(p, x, gy, width, 31, C["Canvas"], 0, "Column header", C["Border"])
        if cc: a.text(p, x + 56, gy + 6, headers[cc - 1], 11, C["Muted"], family="Inter")
    for r, row in enumerate(rows):
        yy = gy + 31 + r * rh
        a.rect(p, gx, yy, rw, rh, C["Canvas"], 0, "Row header", C["Border"])
        a.text(p, gx + 18, yy + 15, str(r + 1), 11, C["Muted"], family="Inter")
        for cc, value in enumerate(row):
            x = gx + rw + cc * cw
            is_range = 1 <= r <= 6 and 1 <= cc <= 5
            fill = C["Sage"] if r == 1 else C["Panel"] if r == 6 else C["Surface"]
            if is_range and r != 1: fill = "#F0F3EB"
            a.rect(p, x, yy, cw, rh, fill, 0, f"Sheet/{headers[cc]}{r+1}", C["Border"])
            a.text(p, x + 13, yy + 13, value, 12, C["Ink"], width=cw - 18, bold=r in (1, 6))
    a.rect(p, gx + rw + cw, gy + 31 + rh, cw * 5, rh * 6, "none", 0,
           "Selected range B2:F7", C["SageInk"], strokeWeight=2)
    a.rect(p, gx + rw + cw * 6 - 4, gy + 31 + rh * 7 - 4, 8, 8, C["SageInk"], 1, "Range fill handle")
    if not picking:
        a.rect(p, gx + rw + cw * 5, gy + 31 + rh * 2, cw, rh, "none", 0,
               "Editing cell F3", C["Accent"], strokeWeight=2)
    a.line(p, 22, 678, 980)
    a.text(p, 28, 694, "+", 19, C["Muted"])
    a.chip(p, 72, 691, "预算", C["Sage"], C["SageInk"], 78)
    a.text(p, 174, 695, "排期", 12, C["Muted"])
    if picking:
        bar = a.frame(p, 24, 748, 976, 82, "Range confirmation", C["Canvas"], radius=14)
        a.text(bar, 17, 12, "预算!B2:F7", 15, bold=True, family="Inter")
        a.text(bar, 17, 44, "6 行 × 5 列 · 实时引用 · 白板中可预览并返回原表", 12, C["Muted"])
        a.button(bar, 674, 22, "取消", 90, target="insert")
        a.button(bar, 776, 22, "引用到白板", 183, "primary", icon="plus", target="range_board")
    else:
        a.button(p, 24, 782, "返回白板", 126, icon="back", target="range_board")
        a.chip(p, 178, 786, "已更新白板中的预算区域", C["Sage"], C["SageInk"], 280, "check", h=28)
        a.text(p, 819, 792, "已自动保存", 11.5, C["SageInk"])


def ai_context(a):
    p = shell(a, selected=True)
    board_chrome(a, p)
    doc_card(a, p, selected=True)
    sheet_card(a, p, x=520, y=296)
    a.chip(p, 552, 204, "两份资料 · 一个持续对话", C["Sage"], C["SageInk"], 285, "link", h=32)
    a.text(p, 103, 665, "从白板到原文，AI 与任务始终在场。", 22, bold=True)
    a.text(p, 104, 712, "上下文由当前页面、当前选区和固定资料共同组成。", 14, C["Muted"])
    popup = a.frame(a.root, AX + 10, 244, AW - 20, 416, "Global AI / Context manager",
                    C["Surface"], C["Border"], radius=16,
                    effects=[{"type": "dropShadow", "color": "#302F2A1C", "offset": [0, 8], "radius": 22}])
    a.text(popup, 17, 15, "管理此对话的上下文", 14.5, bold=True)
    a.icon(popup, 288, 20, "close", 13)
    a.text(popup, 17, 57, "跟随当前页面", 12.5)
    a.text(popup, 17, 83, "切换资源时更新，固定资料继续保留。", 10.5, C["Muted"], width=286)
    a.rect(popup, 270, 59, 35, 20, C["SageInk"], 10, "Follow current resource / on")
    a.rect(popup, 287, 62, 14, 14, C["Surface"], 7)
    a.line(popup, 16, 123, 292)
    a.text(popup, 17, 140, "已固定  2", 11.5, C["Muted"], bold=True)
    for i, (icon, title, sub) in enumerate([
        ("doc", "产品发布方案", "第 2 节 · 发布节奏"),
        ("sheet", "发布预算", "预算!B2:F7"),
    ]):
        yy = 178 + i * 65
        a.icon(popup, 18, yy + 5, icon, 17, C["Accent"] if i == 0 else C["SageInk"])
        a.text(popup, 45, yy - 2, title, 12.5, bold=True)
        a.text(popup, 45, yy + 24, sub, 10.5, C["Muted"])
        a.icon(popup, 287, yy + 8, "close", 11)
    a.button(popup, 16, 317, "添加资料", 291, icon="plus", target="insert")
    a.text(popup, 17, 370, "范围仅限本对话，可随时移除引用。", 10.5, C["Muted"], width=290)
    a.hit(popup, 278, 11, 35, 35, "board", "关闭上下文管理")


def foundations(a):
    a.text(a.root, 56, 39, "OFFICECLI / RESOURCE WORKSPACE", 13, C["Accent"], family="Inter")
    a.text(a.root, 55, 87, "让资料相连，让 AI 随行。", 39, bold=True)
    a.text(a.root, 57, 159, "资源引用与视图 · Claude 风格方向 · 全局 AI", 17, C["Muted"])
    a.text(a.root, 57, 223, "01  暖白底色，克制的层次", 17, bold=True)
    for i, key in enumerate(["Canvas", "Surface", "Ink", "Accent", "SageInk"]):
        x = 57 + i * 208
        a.rect(a.root, x, 270, 184, 90, C[key], 15, "Token/" + key,
               C["Border"] if key in ("Canvas", "Surface") else None)
        a.text(a.root, x, 375, key, 13, bold=True, family="Inter")
        a.text(a.root, x, 401, C[key], 12, C["Muted"], family="Inter")
    a.text(a.root, 57, 465, "02  同一套圆角与内容视图", 17, bold=True)
    for i, (radius, label, desc) in enumerate([
        (26, "26 / 主工作区", "白板与文档共享"),
        (16, "16 / 卡片与 AI", "资料与助手共享"),
        (10, "10 / 操作控件", "工具栏与按钮共享"),
    ]):
        x = 57 + i * 348
        box = a.frame(a.root, x, 509, 321, 143, "Radius/" + str(radius), C["Surface"], C["Border"], radius)
        a.text(box, 20, 18, label, 15, bold=True)
        a.text(box, 20, 53, desc, 12.5, C["Muted"])
        a.button(box, 19, 91, "进入编辑", 119, "primary", icon="edit")
    a.text(a.root, 57, 701, "03  AI 是工作空间能力", 17, bold=True)
    a.text(a.root, 57, 744, "对话与任务跨资源持续。当前页面可以跟随，固定资料由用户管理。", 15, C["Muted"], width=1060)
    for i, (title, subtitle, icon) in enumerate([
        ("白板", "看见关系、讨论与引用", "board"),
        ("原文与原表", "定位准确，继续编辑", "doc"),
        ("全局 AI", "保留对话、上下文与任务", "chat"),
    ]):
        x = 57 + i * 348
        box = a.frame(a.root, x, 805, 321, 111, "Principle/" + title, C["Navigation"], radius=16)
        a.icon(box, 18, 22, icon, 21, C["Accent"])
        a.text(box, 54, 17, title, 16, bold=True)
        a.text(box, 18, 66, subtitle, 13, C["Muted"])
    a.text(a.root, 57, 952, "DESIGN PROTOTYPE  /  1600 × 1000  /  Native editable layers", 11, C["Faint"], family="Inter")
    return make_ai(a, component=True)


def states(a):
    a.text(a.root, 48, 37, "资源视图与全局 AI · 状态约定", 31, bold=True)
    a.text(a.root, 49, 94, "让来源、权限、更新和上下文始终可见。", 15, C["Muted"])
    items = [
        ("实时引用", "源资源已更新", "预览跟随原文或原表，保留引用范围。", C["Sage"], C["SageInk"], "refresh"),
        ("固定版本", "正在查看评审版本", "显示版本与时间；切换实时需要显式操作。", C["BlueSoft"], C["BlueInk"], "clock"),
        ("只读资料", "可以预览与定位", "进入编辑按钮显示只读原因与访问入口。", C["Yellow"], C["Muted"], "doc"),
        ("访问受限", "这项资料暂不可见", "保留卡片位置，提供申请访问或移除入口。", C["AccentSoft"], C["Accent"], "link"),
        ("范围已变化", "引用区域需要重新定位", "保留最后预览，提示重新选择范围。", C["AccentSoft"], C["Accent"], "location"),
        ("正在加载", "正在读取资料预览", "先显示标题与来源，正文使用骨架占位。", C["Canvas"], C["Muted"], "clock"),
    ]
    for i, (title, state, desc, fill, ink, icon) in enumerate(items):
        x, y = 48 + (i % 3) * 510, 160 + (i // 3) * 262
        q = a.frame(a.root, x, y, 484, 235, "State/" + title, C["Surface"], C["Border"], radius=16)
        a.icon(q, 18, 20, icon, 19, ink)
        a.text(q, 50, 14, title, 16, bold=True)
        a.chip(q, 18, 63, state, fill, ink, 443, h=39)
        a.text(q, 19, 123, desc, 13, C["Muted"], width=440, line=25)
        a.text(q, 19, 196, "来源  /  产品发布工作空间", 11, C["Faint"])
    q = a.frame(a.root, 48, 733, 1504, 211, "Global AI persistence contract", C["Navigation"], radius=20)
    a.star(q, 24, 26, 31)
    a.text(q, 73, 20, "切换页面，继续同一段工作。", 23, bold=True)
    for i, (title, desc) in enumerate([
        ("持续保留", "对话、输入草稿、任务进度与固定资料"),
        ("随页面更新", "当前资源、位置、选区和可用操作"),
        ("用户可控", "添加或移除资料，明确本次任务范围"),
    ]):
        x = 28 + i * 495
        a.text(q, x, 93, title, 14, bold=True)
        a.text(q, x, 130, desc, 13, C["Muted"], width=453)


BUILDERS = [
    ("board", "01 · 白板总览 · 资料与全局 AI", lambda a: board(a)),
    ("insert", "02 · 插入资源 · 文档与表格", insert),
    ("doc_preview", "03 · 文档预览 · 定位引用位置", doc_preview),
    ("doc_edit", "04 · 进入原文编辑 · AI 持续", doc_edit),
    ("range", "05 · 选择表格区域 · B2:F7", lambda a: spreadsheet(a, True)),
    ("range_board", "06 · 表格区域卡片 · 实时引用", lambda a: board(a, True)),
    ("sheet_edit", "07 · 进入原表编辑 · 回到白板", lambda a: spreadsheet(a, False)),
    ("ai", "08 · 全局 AI · 管理跨资源上下文", ai_context),
]


def main():
    global AI_ID
    m = FigCraft()
    manifest = {"title": "OfficeCLI · 资源白板与全局 AI", "native": str(NATIVE),
                "canvas": {"width": 1600, "height": 1000},
                "tokens": COLORS, "screens": [], "interactions": []}
    try:
        m.call("open_file", {"path": str(NATIVE)})
        state = m.call("inspect_document", {"depth": 1})
        if any(p.get("children") for p in state["pages"]):
            raise RuntimeError("Refusing to overwrite an already populated design; use an explicit new project.")
        m.command("page.rename", name="00 · 视觉规范与共享组件")
        m.command("page.setBackground", color="#DDD9D0")
        collection = m.command("variable.createCollection", name="OfficeCLI / Warm workspace", modes=["Light"])
        variable_ids = {}
        for name, value in COLORS.items():
            variable_ids[name] = m.command("variable.create", collection=collection["id"],
                                           name=name, type="color", value=value)["id"]
            COLOR_VARIABLES[value] = variable_ids[name]
        cover = Artboard("foundation", "00 · 视觉规范与全局 AI 组件")
        ai_alias, bindings = foundations(cover)
        cover.submit(m)
        AI_ID = cover.ids[ai_alias]
        for name, layer in bindings.items():
            m.command("component.addProperty", id=AI_ID, name=name,
                      type="boolean" if name == "HasSelection" else "text",
                      layer=cover.ids[layer], **({"default": False} if name == "HasSelection" else {}))
        m.call("export", {"ids": [cover.frame_id], "format": "png", "scale": 1,
                          "path": str(ROOT / "previews/00-foundations.png")})
        m.save()
        print("Created shared Global AI component and visual system", flush=True)
        flow_page = m.command("page.add", name="01 · 资源引用与编辑流程")["id"]
        m.command("page.setBackground", color="#DDD9D0")
        boards = []
        for i, (key, name, builder) in enumerate(BUILDERS):
            a = Artboard(key, name, (i % 2) * 1720, (i // 2) * 1120)
            builder(a)
            a.submit(m)
            boards.append(a)
            path = ROOT / "previews" / f"{i+1:02d}-{key.replace('_', '-')}.png"
            m.call("export", {"ids": [a.frame_id], "format": "png", "scale": 1, "path": str(path)})
            manifest["screens"].append({"key": key, "name": name, "id": a.frame_id,
                                         "page": flow_page, "preview": str(path),
                                         "layers": len(a.commands)})
            m.save()
            print(f"Created {key}: {len(a.commands)} editable creation steps", flush=True)
        mapping = {a.key: a.frame_id for a in boards}
        for a in boards:
            steps = []
            for alias, target, label in a.hotspots:
                steps.append({"command": "proto.interaction.add", "params": {
                    "id": a.ids[alias], "dest": mapping[target], "trigger": {"type": "onClick"},
                    "transition": {"type": "dissolve"}, "durationMs": 180}})
                manifest["interactions"].append({"screen": a.key, "label": label, "target": target})
            m.call("batch", {"label": "Prototype / " + a.name, "commands": steps})
        m.command("proto.flow.add", start=mapping["board"], name="资源引用与全局 AI")
        m.command("proto.settings", width=1600, height=1000, background=C["Canvas"])
        states_page = m.command("page.add", name="02 · 状态与交互约定")["id"]
        s = Artboard("states", "09 · 资源状态与全局 AI 持续性")
        states(s)
        s.submit(m)
        m.call("export", {"ids": [s.frame_id], "format": "png", "scale": 1,
                          "path": str(ROOT / "previews/09-states.png")})
        manifest["supportingFrames"] = [
            {"key": "foundations", "id": cover.frame_id, "page": 1},
            {"key": "states", "id": s.frame_id, "page": states_page},
        ]
        m.command("page.select", id=flow_page)
        m.call("select", {"ids": [mapping["board"]]})
        m.save()
        fonts = m.command("file.fontReport")
        snapshot = m.call("inspect_document", {"allPages": True, "depth": 2, "maxBytes": 2000000,
            "fields": ["name", "type", "width", "height", "cornerRadius", "mainComponent", "interactions"]})
        (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        (ROOT / "inspection.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
        (ROOT / "font-report.json").write_text(json.dumps(fonts, ensure_ascii=False, indent=2))
        validation = {"nativeExists": NATIVE.is_file(), "nativeBytes": NATIVE.stat().st_size,
                      "screens": len(boards), "supportingFrames": 2, "globalAIComponent": AI_ID,
                      "prototypeLinks": len(manifest["interactions"]),
                      "allTargetsExist": all(i["target"] in mapping for i in manifest["interactions"]),
                      "previewsExist": all(Path(s["preview"]).stat().st_size > 0 for s in manifest["screens"]),
                      "fontReport": fonts}
        (ROOT / "validation.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2))
        print(json.dumps({k: v for k, v in validation.items() if k != "fontReport"}, ensure_ascii=False), flush=True)
    finally:
        m.close()


if __name__ == "__main__":
    main()
