"""Revise the complete office design and import editable abstract SVG symbols via MCP."""
from pathlib import Path
import json
import hashlib
import sys

ROOT=Path(__file__).resolve().parent
V2=ROOT.parent/"officecli-resource-workspace-v2"
sys.path.insert(0,str(V2))
import extend_design as office
from prepare_svg_assets import STATES

SOURCE=V2/"officecli-office-workspace-v2.figcraft"
NATIVE=ROOT/"officecli-office-workspace-v3-triangle.figcraft"
office.fc.ROOT,office.fc.NATIVE=ROOT,NATIVE
BEFORE=office.C.copy()
PALETTE={
    "Canvas":"#EDEEE9","Navigation":"#E2E4DE","Stage":"#F4F5F0",
    "Surface":"#FFFFFF","Panel":"#F8F8F3","Ink":"#252722",
    "Muted":"#61655C","Faint":"#686D63","Border":"#CACEC6",
    "Accent":"#B75F42","AccentSoft":"#F5E7DF","Sage":"#E8EFE3",
    "SageInk":"#52664B","BlueSoft":"#E5ECF5","BlueInk":"#46628E",
    "Yellow":"#F2EACF","Bubble":"#E7E9E2","Dark":"#282B25",
}
office.C.update(PALETTE)
office.bd.COLOR_VARIABLES.clear()
A=office.A
C=office.C


def add_svg(m,path,parent,x,y,name):
    result=m.command("file.import",path=str(path),x=0,y=0)
    identifier=result["id"]
    m.command("node.reparent",ids=[identifier],parent=parent)
    m.call("set_properties",{"ids":[identifier],"props":{"x":x,"y":y,"name":name}})
    return identifier


def main():
    if NATIVE.exists() and "--rebuild" not in sys.argv:raise SystemExit("V3 exists; use --rebuild explicitly.")
    m=office.fc.FigCraft()
    try:
        m.call("open_file",{"path":str(SOURCE)})
        m.call("save_file",{"path":str(NATIVE)})
        m.command("file.rename",name="OfficeCLI · 墨色与陶土 · 角角 SVG")
        variables=m.command("variable.list")
        for v in variables["variables"]:
            if v["name"] in C:
                m.command("variable.set",variable=v["id"],value=C[v["name"]])
                office.bd.COLOR_VARIABLES[C[v["name"]]]=v["id"]
        m.command("variable.renameCollection",collection="VariableCollectionId:1",name="OfficeCLI / Ink and clay")
        snapshot=m.call("inspect_document",{"allPages":True,"depth":10,"maxBytes":7000000,
            "fields":["name","type","characters","x","y","width","height","fills","strokes","boundVariables","fontStyle"]})
        patch=[]
        literal={**{value:C[key] for key,value in BEFORE.items()},
                 "#EFF3F8":"#E5E8E1","#DCE4EE":"#CFD4CA","#DCE5F1":"#D9DED3","#F0F4FA":"#EEF1E8"}
        for page in snapshot["pages"]:
            m.command("page.select",id=page["id"]);m.command("page.setBackground",color="#D8DBD2")
            for n in office.walk(page,True):
                props={}
                for field,key in [("fills","fill"),("strokes","stroke")]:
                    if key in n.get("boundVariables",{}):continue
                    paints=n.get(field,[])
                    if len(paints)==1 and paints[0].get("type")=="solid" and paints[0].get("opacity",1)>.1:
                        if paints[0].get("color") in literal:props[key]=literal[paints[0]["color"]]
                text=n.get("characters","")
                if text in literal:props["characters"]=literal[text]
                if text=="01  浅灰白底色，清晰的层次":props["characters"]="01  墨色、纸白与陶土，拉开层次"
                if text=="统一办公工作空间 · 浅灰白与低饱和蓝":props["characters"]="统一办公工作空间 · 强化对比与状态动效"
                if n.get("name") in ("Workspace helper",):props["fill"]={"$var":"VariableID:11"}
                if n.get("name") in ("Excel selection","Excel active cell F7","Selected range B2:F7","Range outline"):
                    props["stroke"]={"$var":"VariableID:15"}
                if props:patch.append({"command":"node.set","params":{"ids":[n["id"]],"props":props}})
                if n.get("name")=="Workspace navigation":
                    for child in n.get("children",[]):
                        if child.get("name")=="Active resource":
                            patch.append({"command":"node.set","params":{"ids":[child["id"]],"props":{"fill":{"$var":"VariableID:18"}}}})
                            top=child["y"]
                            for sibling in n.get("children",[]):
                                if top<=sibling.get("y",-100)<top+36 and sibling.get("type") in ("TEXT","VECTOR"):
                                    patch.append({"command":"node.set","params":{"ids":[sibling["id"]],"props":{
                                        "fill":{"$var":"VariableID:4"}} if sibling["type"]=="TEXT" else {"stroke":{"$var":"VariableID:4"}}}})
                        if child.get("name")=="Workspace home" and child.get("boundVariables",{}).get("fill")=="VariableID:4":
                            patch.append({"command":"node.set","params":{"ids":[child["id"]],"props":{"fill":{"$var":"VariableID:18"}}}})
                            for detail in office.walk(child):
                                if detail.get("type")=="TEXT":patch.append({"command":"node.set","params":{"ids":[detail["id"]],"props":{"fill":{"$var":"VariableID:4"}}}})
                                elif detail.get("type")=="VECTOR":patch.append({"command":"node.set","params":{"ids":[detail["id"]],"props":{"stroke":{"$var":"VariableID:4"}}}})
        m.call("batch",{"label":"V3 / Ink, paper and clay contrast","commands":patch})
        ai=m.call("get_node",{"id":56,"depth":7,"fields":["name","type","x","y","characters"]})
        task=next(n for n in office.walk(ai) if n.get("name")=="AI cross-resource task")
        status=next(n for n in office.walk(task) if n.get("name")=="Chip/进行中")
        status_ids={n["id"] for n in office.walk(status)}
        taskpatch=[{"command":"node.set","params":{"ids":[task["id"]],"props":{"fill":{"$var":"VariableID:18"},"stroke":{"$var":"VariableID:18"}}}}]
        for n in office.walk(task):
            if n["id"] in status_ids:continue
            if n.get("type")=="TEXT":
                taskpatch.append({"command":"node.set","params":{"ids":[n["id"]],"props":{"fill":"#F4F5EF"}}})
            elif n.get("type")=="VECTOR":
                taskpatch.append({"command":"node.set","params":{"ids":[n["id"]],"props":{"stroke":"#D4D9CB"}}})
        selection=next(n for n in office.walk(ai) if n.get("name")=="AI/selectionPill")
        taskpatch.append({"command":"node.set","params":{"ids":[selection["id"]],"props":{"fill":{"$var":"VariableID:14"}}}})
        for n in office.walk(selection):
            if n.get("type")=="TEXT":taskpatch.append({"command":"node.set","params":{"ids":[n["id"]],"props":{"fill":{"$var":"VariableID:15"}}}})
        m.call("batch",{"label":"V3 / Global AI hierarchy","commands":taskpatch})
        marks=[n for n in office.walk(ai) if n.get("name")=="Global AI / Mark"]
        for mark in marks:
            m.command("edit.delete",ids=[mark["id"]])
            header=mark["y"]<100
            add_svg(m,ROOT/("svg/jiaojiao-mark-static.svg" if header else "svg/jiaojiao-inline-static.svg"),
                    56,16 if header else 18,16 if header else 351,
                    "角角 / Global AI symbol" if header else "角角 / AI response")
        original=json.loads((V2/"manifest.json").read_text())
        page=original["screens"][0]["page"]
        m.command("page.select",id=page)
        m.command("page.rename",id=page,name="01 · 统一办公与角角")

        # Abstract symbol identity and six editable static states.
        identity=A("identity","32 · 角角 · 原创 SVG 符号",0,16800)
        identity.text(identity.root,43,32,"角角，让下一步轻一点。",32,bold=True)
        identity.text(identity.root,45,91,"圆角三角 · 小眼睛与斜刘海 · 六种状态动效",15,C["Muted"])
        hero=identity.frame(identity.root,32,157,424,795,"Symbol hero",C["Surface"],C["Border"],radius=20)
        identity.text(hero,25,24,"角角",38,bold=True)
        identity.text(hero,26,92,"JIAOJIAO / GLOBAL AI COMPANION",11.5,C["Accent"],family="Inter")
        identity.text(hero,26,594,"一点斜刘海，一起想下一步。",16,bold=True)
        identity.text(hero,26,638,"柔软的三角轮廓，配上小眼睛与斜刘海。\n眨眼、歪头和弹性伸缩，让状态更灵动。",13,C["Muted"],width=368,line=27)
        posecards=[]
        for i,(state,(label,timing)) in enumerate(STATES.items()):
            x,y=480+(i%3)*360,157+(i//3)*406
            card=identity.frame(identity.root,x,y,336,389,"Symbol/"+state,C["Surface"],C["Border"],radius=16)
            identity.text(card,19,14,label,17,bold=True)
            identity.text(card,19,344,timing,11.5,C["Muted"],width=300)
            posecards.append((state,card))
        identity.submit(m)
        add_svg(m,ROOT/"svg/jiaojiao-hero-static.svg",identity.ids[hero],32,181,"角角 / Hero vector")
        for state,card in posecards:add_svg(m,ROOT/f"svg/jiaojiao-{state}-static.svg",identity.ids[card],58,93,"角角 / "+state)

        motion=A("motion","33 · SVG 动效 · 状态与时序",1720,16800)
        motion.text(motion.root,43,32,"让动效解释状态。",33,bold=True)
        motion.text(motion.root,45,92,"有任务才运动，有结果才反馈；可暂停，并尊重减少动态效果偏好。",15,C["Muted"])
        cards=[]
        descriptions={
            "idle":"轻轻呼吸和自然眨眼，安静等待下一步。",
            "thinking":"轻歪头与向上的视线，思考点依次出现。",
            "working":"弹性轻跳与视线轻移，表示任务仍在执行。",
            "complete":"开心眯眼、短促轻跳与勾线各播放一次。",
            "waiting":"主体静止，保留自然眨眼与暂停标记。",
            "attention":"来源变化时轻量提示，核对后继续。"}
        for i,(state,(label,timing)) in enumerate(STATES.items()):
            card=motion.frame(motion.root,32+(i%2)*784,154+(i//2)*266,768,246,
                              "Motion/"+state,C["Surface"],C["Border"],radius=16)
            motion.text(card,242,28,label,23,bold=True)
            motion.text(card,243,81,timing,12.5,C["Accent"],width=492)
            motion.text(card,243,127,descriptions[state],13,C["Muted"],width=488,line=25)
            motion.text(card,243,197,"SVG / CSS · 状态驱动 · 可暂停",11.5,C["Faint"],width=488)
            cards.append((state,card))
        motion.submit(m)
        for state,card in cards:add_svg(m,ROOT/f"svg/jiaojiao-{state}-static.svg",motion.ids[card],6,8,"符号状态 / "+state)

        welcome=A("welcome","34 · 全局 AI · 角角与工作空间",0,17920)
        stage,_=office.shell(welcome,"library","继续你的工作")
        welcome.text(stage,39,37,"把想法，交给下一步。",32,bold=True)
        welcome.text(stage,41,97,"文字、表格、图片与白板，和全局 AI 一起继续。",14,C["Muted"])
        welcome.text(stage,490,239,"一起，把工作做得更清楚。",25,bold=True,width=472)
        welcome.text(stage,491,302,"从整理资料、编辑文档，到核对预算和处理图片。\n角角会随着任务状态，给出轻量、明确的反馈。",14,C["Muted"],width=463,line=29)
        welcome.button(stage,490,406,"开始整理资料",186,"primary",icon="plus",target="library")
        welcome.button(stage,690,406,"查看符号与动效",247,icon="chat",target="motion")
        welcome.text(stage,490,482,"从一份文档开始，也可以导入表格或图片。",12,C["Muted"],width=470)
        welcome.text(stage,43,763,"对话、固定资料和任务随工作空间持续；当前页面和选区清晰可见。",12,C["Muted"],width=930)
        welcome.submit(m)
        welcome_tree=m.call("get_node",{"id":welcome.frame_id,"depth":4,"fields":["name","type"]})
        home=next(n for n in office.walk(welcome_tree) if n.get("name")=="Workspace home")
        m.call("set_properties",{"ids":[home["id"]],"props":{"fill":C["Dark"]}})
        for n in office.walk(home):
            if n.get("type")=="TEXT":m.call("set_properties",{"ids":[n["id"]],"props":{"fill":C["Surface"]}})
            elif n.get("type")=="VECTOR":m.call("set_properties",{"ids":[n["id"]],"props":{"stroke":C["Surface"]}})
        add_svg(m,ROOT/"svg/jiaojiao-hero-static.svg",welcome.ids[stage],66,210,"角角 / Work symbol")
        add_svg(m,ROOT/"svg/resource-link.svg",welcome.ids[stage],490,544,"资源引用 / 连线动效静态姿态")

        mapping={s["key"]:s["id"] for s in original["screens"]}
        mapping.update(identity=identity.frame_id,motion=motion.frame_id,welcome=welcome.frame_id)
        for alias,target,label in welcome.hotspots:
            m.command("proto.interaction.add",id=welcome.ids[alias],dest=mapping[target],
                      transition={"type":"dissolve"},durationMs=180)
        m.command("proto.flow.add",start=welcome.frame_id,name="墨色与陶土 · 角角")
        m.call("select",{"ids":[welcome.frame_id]})
        m.call("save_file",{"path":str(NATIVE)})
        frames=[]
        for s in original["screens"]:
            target=ROOT/"previews"/Path(s["preview"]).name
            m.call("export",{"ids":[s["id"]],"format":"png","scale":1,"path":str(target)})
            frames.append({**s,"preview":str(target)})
        for a,filename in [(identity,"32-symbol.png"),(motion,"33-motion.png"),(welcome,"34-welcome.png")]:
            target=ROOT/"previews"/filename
            m.call("export",{"ids":[a.frame_id],"format":"png","scale":1,"path":str(target)})
            frames.append({"key":a.key,"name":a.name,"id":a.frame_id,"page":page,"preview":str(target)})
        for support in original["supportingFrames"]:
            filename="00-foundations.png" if support["key"]=="foundations" else "09-states.png"
            m.call("export",{"ids":[support["id"]],"format":"png","scale":1,"path":str(ROOT/"previews"/filename)})
        m.command("variable.export",collections=["VariableCollectionId:1"],format="css",path=str(ROOT/"ink-clay.tokens.css"))
        fonts=m.command("file.fontReport")
        final=m.call("inspect_document",{"allPages":True,"depth":12,"maxBytes":7000000,
            "fields":["name","type","mainComponent","interactions"]})
        nodes=[n for page in final["pages"] for n in office.walk(page,True)]
        identifiers={n["id"] for n in nodes}
        interactions=[i for n in nodes for i in n.get("interactions",[])]
        destinations=[action["dest"] for i in interactions for action in i.get("actions",[])
                      if action.get("type")=="navigate"]
        manifest={"title":"OfficeCLI · 墨色与陶土 · 角角 SVG","native":str(NATIVE),"source":str(SOURCE),
                  "palette":PALETTE,"screens":frames,"supportingFrames":original["supportingFrames"],
                  "svgStates":list(STATES),"motionPreview":str(ROOT/"svg/manifest.json")}
        (ROOT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
        verification={"totalFrames":len(frames)+2,"missingFonts":fonts["missing"],"svgStates":6,
            "svgFiles":len(list((ROOT/"svg").glob("*.svg"))),"nativeBytes":NATIVE.stat().st_size,
            "sourceV2Unchanged":hashlib.sha256(SOURCE.read_bytes()).hexdigest()==json.loads((V2/"validation.json").read_text())["nativeSHA256"],
            "totalPrototypeLinks":len(interactions),
            "allNavigationDestinationsExist":all(d in identifiers for d in destinations),
            "sharedGlobalAIInstances":sum(n.get("mainComponent")==56 for n in nodes),
            "nativeSHA256":hashlib.sha256(NATIVE.read_bytes()).hexdigest(),
            "nativeScope":"Editable static symbol states and timing boards; SVG animations run in the browser."}
        (ROOT/"validation.json").write_text(json.dumps(verification,ensure_ascii=False,indent=2))
        (ROOT/"font-report.json").write_text(json.dumps(fonts,ensure_ascii=False,indent=2))
        print(json.dumps(verification,ensure_ascii=False),flush=True)
    finally:m.close()


if __name__=="__main__":main()
