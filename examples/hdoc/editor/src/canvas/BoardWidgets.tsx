import { useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Pause, Play, RotateCcw, Music2, Settings2 } from 'lucide-react'
import { insertBoardShapes, type BoardPoint } from './boardObjects'
import type { CanvasElement, ReactionKind } from './model'
import { ReactionGlyph, type useCanvasReactions } from './CanvasReactions'
import { PaintMask,usePaintStack } from './paintStack'
import type { BoardWidget } from './BoardInsertMenu'

type Widget = { kind: BoardWidget; until?: number; remaining?: number; duration?: number }
const widgetOf = (e: CanvasElement) =>
  (e.customData as { officeWidget?: Widget } | undefined)?.officeWidget
export function insertWidget(
  editor: ExcalidrawImperativeAPI,
  kind: BoardWidget,
  point: BoardPoint,
) {
  const id = 'widget-' + crypto.randomUUID()
  const data: Widget =
    kind === 'timer' ? { kind, until: 0, remaining: 180000 } : { kind }
  const groupIds = [id + '-group']
  insertBoardShapes(
    editor,
    [
      {
        id,
        type: 'rectangle',
        ...point,
        width: 244,
        height: 108,
        roundness: { type: 3 },
        roughness: 0,
        strokeWidth: 1,
        fillStyle: 'solid',
        strokeColor: '#d9d6de',
        backgroundColor: '#ffffff',
        groupIds,
        customData: { officeWidget: data },
      },
      {
        id: id + '-title',
        type: 'text',
        x: point.x + 17,
        y: point.y + 13,
        text: kind === 'timer' ? '工作坊计时器' : '举手表决',
        fontFamily: 2,
        fontSize: 16,
        strokeColor: '#302b37',
        groupIds,
      },
      {
        id: id + '-fallback',
        type: 'text',
        x: point.x + 18,
        y: point.y + 58,
        text: kind === 'timer' ? '03:00' : '赞成   /   有想法',
        fontFamily: 2,
        fontSize: 19,
        strokeColor: '#554363',
        groupIds,
      },
    ],
    id,
  )
  return id
}
export function openMeetingTimer(editor:ExcalidrawImperativeAPI){
  const scene=editor.getSceneElements(),current=scene.find(el=>widgetOf(el as CanvasElement)?.kind==='timer')
  if(current){
    editor.scrollToContent(current,{animate:!matchMedia('(prefers-reduced-motion: reduce)').matches})
    editor.updateScene({appState:{selectedElementIds:{[current.id]:true}},captureUpdate:CaptureUpdateAction.NEVER})
    return
  }
  const app=editor.getAppState(),z=app.zoom.value
  const x=(app.width-22)/z-app.scrollX-244,top=62/z-app.scrollY
  let y=top
  for(const el of [...scene].sort((a,b)=>a.y-b.y)){
    if(el.x<x+244 && el.x+el.width>x && el.y<y+108 && el.y+el.height>y)y=el.y+el.height+16
  }
  insertWidget(editor,'timer',{x,y})
  if(y+108>app.height/z-app.scrollY){
    const timer=editor.getSceneElements().find(el=>widgetOf(el as CanvasElement)?.kind==='timer')
    if(timer)editor.scrollToContent(timer)
  }
}
function TimerControls({
  widget,
  change,
  editable,
}: {
  widget: Widget
  change: (value: Widget) => void
  editable: boolean
}) {
  const [now, tick] = useState(Date.now)
  const duration=widget.duration??180000
  const [settings,setSettings]=useState(false),[music,setMusic]=useState(false)
  const [minutes,setMinutes]=useState(3),[secs,setSecs]=useState(0)
  const sound=useRef<AudioContext|null>(null)
  const until = widget.until || 0
  useEffect(()=>()=>{void sound.current?.close()},[])
  useEffect(()=>{
    const ctx=sound.current
    if(!ctx||!music||until<=Date.now())return
    const scale=[261.63,329.63,392,293.66,349.23,392]
    let step=0
    const play=()=>{
      if(Date.now()>=until||document.hidden)return
      const tone=ctx.createOscillator(),gain=ctx.createGain(),t=ctx.currentTime
      tone.frequency.value=scale[step++%scale.length];gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(.032,t+.08);gain.gain.exponentialRampToValueAtTime(.0001,t+1.1)
      tone.connect(gain);gain.connect(ctx.destination);tone.start(t);tone.stop(t+1.2)
    }
    play();const id=setInterval(play,1400);return()=>clearInterval(id)
  },[music,until])
  useEffect(() => {
    tick(Date.now())
    if (until <= Date.now()) return
    const timer = setInterval(() => {
      const t = Date.now()
      tick(t)
      if (t >= until) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [until])
  const remaining = until
      ? Math.max(0, until - now)
      : (widget.remaining ?? 180000),
    running = until > now
  const seconds = Math.ceil(remaining / 1000)
  return (
    <>
      <output aria-label="剩余时间">
        {String(Math.floor(seconds / 60)).padStart(2, '0')}:
        {String(seconds % 60).padStart(2, '0')}
      </output>
      <button
        disabled={!editable}
        aria-label={running ? '暂停计时' : '开始计时'}
        onClick={() =>
          change(
            running
              ? {
                  kind: 'timer',
                  until: 0,
                  remaining: Math.max(0, until - Date.now()),duration,
                }
              : {
                  kind: 'timer',
                  until: Date.now() + (remaining || duration),duration,
                  remaining: 0,
                },
          )
        }
      >
        {running ? <Pause /> : <Play />}
      </button>
      <button
        disabled={!editable}
        aria-label="重置计时"
        onClick={() => change({ kind: 'timer', until: 0, remaining: duration,duration })}
      >
        <RotateCcw />
      </button>
      <button aria-label="计时设置" aria-expanded={settings} onClick={()=>{setMinutes(Math.floor(duration/60000));setSecs(Math.floor(duration/1000)%60);setSettings(!settings)}}><Settings2/></button>
      {settings&&<form className="timer-settings" aria-label="设置倒计时" onSubmit={e=>{e.preventDefault();const ms=(minutes*60+secs)*1000;if(editable&&ms>0)change({kind:'timer',duration:ms,remaining:ms,until:0});setSettings(false)}}>
        <label>分<input type="number" aria-label="分钟" min="0" max="999" value={minutes} disabled={!editable} onChange={e=>setMinutes(Number(e.target.value))}/></label>
        <label>秒<input type="number" aria-label="秒" min="0" max="59" value={secs} disabled={!editable} onChange={e=>setSecs(Number(e.target.value))}/></label>
        <button type="button" title="本机背景音乐" aria-label="本机背景音乐" aria-pressed={music} onClick={()=>{if(!music){sound.current??=new AudioContext();void sound.current.resume()}setMusic(!music)}}><Music2/></button>
        <button disabled={!editable||minutes*60+secs<=0} type="submit">应用</button></form>}
    </>
  )
}
type Props = {
  editor: ExcalidrawImperativeAPI
  scene: readonly CanvasElement[]
  camera: { x: number; y: number; zoom: number }
  editable: boolean
  feedback: ReturnType<typeof useCanvasReactions>
  onReact: (ids: string[], kind: ReactionKind) => void
}
export function BoardWidgets({
  editor,
  scene,
  camera,
  editable,
  feedback,
  onReact,
}: Props) {
  const stack=usePaintStack(editor)
  return (
    <div className="board-widgets">
      {scene
        .filter((el) => !el.isDeleted && widgetOf(el))
        .map((stored) => {
          const el=stack.find(n=>n.id===stored.id)??stored
          const w=widgetOf(el as CanvasElement)??widgetOf(stored)!
          const left = (el.x + camera.x) * camera.zoom,
            top = (el.y + camera.y) * camera.zoom
          const scaleX = el.width / 244,
            scaleY = el.height / 108
          const change = (value: Widget) =>
            editor.updateScene({
              elements: editor
                .getSceneElementsIncludingDeleted()
                .map((e) =>
                  e.id === el.id
                    ? newElementWith(e, {
                        customData: { ...e.customData, officeWidget: value },
                      })
                    : e,
                ),
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            })
          return (
            <PaintMask key={el.id} api={editor} scene={stack} id={el.id} x={el.x} y={el.y} width={el.width} height={el.height} angle={Number(el.angle||0)} ignoreGroup={el.id+'-group'}>{maskImage=><div
              style={{
                maskImage,left,
                top,
                width: el.width,
                height: el.height,
                transform:
                  'scale(' +
                  camera.zoom +
                  ') rotate(' +
                  Number(el.angle || 0) +
                  'rad)',
                transformOrigin: '0 0',
              }}
            >
              <div
                className="board-widget-controls"
                aria-label={w.kind === 'timer' ? '共享计时器' : '反馈投票'}
                style={{
                  left: 12 * scaleX,
                  top: 40 * scaleY,
                  width: 218 * scaleX,
                  height: 56 * scaleY,
                }}
              >
                {w.kind === 'timer' ? (
                  <TimerControls
                    widget={w}
                    change={change}
                    editable={editable}
                  />
                ) : (
                  (
                    [
                      ['thumbsUp', '赞成'],
                      ['insight', '有想法'],
                    ] as const
                  ).map(([kind, name]) => (
                    <button
                      key={kind}
                      disabled={!editable || feedback.busy || !feedback.book}
                      aria-pressed={
                        !!feedback.book?.elements[el.id]?.[kind]?.mine
                      }
                      onClick={() => onReact([el.id], kind)}
                    >
                      <ReactionGlyph kind={kind} size={20} />
                      {name}{' '}
                      {feedback.book?.elements[el.id]?.[kind]?.count || 0}
                    </button>
                  ))
                )}
              </div>
            </div>}</PaintMask>
          )
        })}
    </div>
  )
}
