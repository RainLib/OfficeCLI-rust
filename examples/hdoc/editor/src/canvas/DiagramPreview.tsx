import type { Composition } from './model.ts'

/** Illustrative layout only. These labels never enter the generated scene. */
export function DiagramPreview({ layout }: { layout: Composition['layout'] }) {
  const card = (x: number, y: number, w: number, title: string, tint = '#fffefb') => <g><rect x={x} y={y} width={w} height={40} rx={9} fill={tint} stroke="#cacec6" /><text x={x + w / 2} y={y + 24} textAnchor="middle" fill="#252722" fontSize={10}>{title}</text></g>
  return <svg className="compose-diagram-preview" viewBox="0 0 300 280" role="img" aria-label="图解版式示意，实际内容由 AI 生成">
    {layout === 'flowchart' ? <>
      <path d="M150 57V81 M150 147V165Q150 173 142 173H73Q65 173 65 181V200 M150 165Q150 173 158 173H227Q235 173 235 181V200" fill="none" stroke="#a77b40" strokeWidth={1.5} strokeLinecap="round" />
      {card(105, 18, 90, '开始', '#f7e9e1')}<path d="M150 81L205 115L150 149L95 115Z" fill="#fff2d9" stroke="#d9c9ac" /><text x={150} y={119} textAnchor="middle" fontSize={10} fill="#705426">条件判断</text>
      <text x={79} y={170} fontSize={9} fill="#61655c">满足</text><text x={208} y={170} fontSize={9} fill="#61655c">不满足</text>{card(20, 200, 90, '继续处理')}{card(190, 200, 90, '调整方案')}
    </> : layout === 'architecture' ? <>
      {[12, 102, 192].map((y, i) => <g key={y}><rect x={12} y={y} width={276} height={74} rx={12} fill={['#f4f2ec', '#f0f3ee', '#eff2f6'][i]} /><text x={24} y={y + 17} fill="#61655c" fontSize={9}>{['访问层', '应用层', '数据层'][i]}</text></g>)}
      <path d="M150 76V91Q150 99 142 99H88Q80 99 80 107V127 M150 91Q150 99 158 99H212Q220 99 220 107V127 M80 167V215 M220 167V215" fill="none" stroke="#71877d" strokeWidth={1.5} strokeLinecap="round" />
      {card(95, 36, 110, '客户端')}{card(28, 127, 104, '业务服务')}{card(168, 127, 104, 'AI 服务')}{card(28, 216, 104, '数据库', '#e9eff6')}{card(168, 216, 104, '文档资源', '#e9eff6')}
    </> : layout === 'mindmap' ? <>
      <path d="M104 133H102Q98 133 98 125V72Q98 64 90 64H84" fill="none" stroke="#59745f" strokeWidth={1.5} />
      <path d="M104 149H102Q98 149 98 157V212Q98 220 90 220H84" fill="none" stroke="#b75f42" strokeWidth={1.5} />
      <path d="M196 133H198Q202 133 202 125V72Q202 64 210 64H216" fill="none" stroke="#54728c" strokeWidth={1.5} />
      <path d="M196 149H198Q202 149 202 157V212Q202 220 210 220H216" fill="none" stroke="#886c8f" strokeWidth={1.5} />
      {card(9, 44, 85, '观察', '#edf2ea')}{card(9, 200, 85, '问题', '#f7e9e1')}{card(206, 44, 85, '灵感', '#edf1f6')}{card(206, 200, 85, '尝试', '#f3edf4')}
      <rect x={104} y={113} width={92} height={55} rx={14} fill="#b75f42" /><text x={150} y={146} textAnchor="middle" fill="white" fontSize={12}>中心主题</text>
    </> : <>
      <path d="M44 39V245" stroke="#d9c9bd" strokeWidth={2} />
      {['理解概念', '观察例题', '动手练习', '归纳总结'].map((title, i) => <g key={title}><circle cx={44} cy={39 + i * 62} r={13} fill={i === 0 ? '#b75f42' : '#f7e9e1'} /><text x={44} y={43 + i * 62} textAnchor="middle" fontSize={10} fill={i === 0 ? 'white' : '#b75f42'}>{i + 1}</text>{card(70, 19 + i * 62, 206, title, ['#fffefb', '#e9f0e7', '#f2ebf6', '#fffefb'][i])}</g>)}
    </>}
  </svg>
}
