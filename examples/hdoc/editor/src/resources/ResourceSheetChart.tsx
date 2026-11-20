import type { ResourcePreview, SheetPresentation } from './resourceReference'

const colors = ['#456fc3', '#458775', '#b07433', '#8764b5', '#b75e69', '#2b82a9']
const axisNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumSignificantDigits: 3 })

export function ResourceSheetChart({ preview, type }: { preview: ResourcePreview; type: Exclude<SheetPresentation, 'table'> }) {
  const { rows = [], numbers = [], columns = [], firstRow = 1 } = preview
  const hasHeader = rows.length > 1 && rows[0].some(text => text.trim()) &&
    numbers[0]?.every(value => value === null) && numbers.slice(1).some(row => row.some(value => value !== null))
  const offset = hasHeader ? 1 : 0
  const series = columns.flatMap((column, index) => {
    const values = numbers.slice(offset).map(row => row[index] ?? null)
    const name = (hasHeader && rows[0][index]?.trim()) || column
    return values.some(value => value !== null) ? [{ index, name, values }] : []
  })
  const labelColumn = columns.findIndex((_, index) => !series.some(item => item.index === index) && rows.slice(offset).some(row => row[index]?.trim()))
  const labels = rows.slice(offset).map((row, index) => row[labelColumn]?.trim() || String(firstRow + offset + index))
  if (!series.length) return <p role="status">所选区域暂无可绘制的数值。</p>

  const values = series.flatMap(item => item.values.flatMap(value => value === null ? [] : [value]))
  const factor = Math.max(...values.map(Math.abs)) || 1
  let min = Math.min(0, ...values.map(value => value / factor))
  let max = Math.max(0, ...values.map(value => value / factor))
  if (min === max) { min = 0; max = 1 }
  const width = Math.max(430, 55 + labels.length * Math.max(35, series.length * (type === 'bar' ? 12 : 7)))
  const height = 190, left = 52, right = 12, top = 12, bottom = 34
  const step = (width - left - right) / labels.length, marker = (index: number) => left + (index + .5) * step
  const y = (value: number) => top + (max - value / factor) / (max - min) * (height - top - bottom)
  const zero = y(0), barWidth = Math.min(32, step * .77 / series.length)
  const compact = (value: number) => value === 0 ? '0' :
    Math.abs(value) < .001 ? value.toExponential(1) : axisNumber.format(value)
  return <figure className="resource-sheet-chart" aria-label={`${preview.label} · ${type === 'bar' ? '柱状图' : '折线图'}`}>
    <div className="resource-chart-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={preview.label} style={{ minWidth: width > 570 ? width : undefined }}>
        {[0, 1, 2, 3, 4].map(tick => {
          const py = top + tick / 4 * (height - top - bottom)
          const value = (max * (1 - tick / 4) + min * (tick / 4)) * factor
          return <g key={tick}><path d={`M${left} ${py}H${width - right}`}/><text x={left - 8} y={py} dy=".32em" textAnchor="end">{compact(value)}</text></g>
        })}
        <path className="resource-chart-zero" d={`M${left} ${zero}H${width - right}`}/>
        {labels.map((label, index) => <text key={index} x={marker(index)} y={height - 12} textAnchor="middle">
          {Array.from(label).length > 7 ? Array.from(label).slice(0, 6).join('') + '…' : label}<title>{label}</title>
        </text>)}
        {series.map((item, column) => {
          const color = colors[column % colors.length]
          return <g key={item.index} fill={color}>
            {type === 'line' && <path className="resource-chart-series" stroke={color} d={item.values.map((value, index) =>
              value === null ? '' : `${index === 0 || item.values[index - 1] === null ? 'M' : 'L'}${marker(index)} ${y(value)}`).join(' ')}/>}
            {item.values.map((value, index) => {
              if (value === null) return null
              const title = <title>{labels[index]} · {item.name} · {String(value)}</title>
              return type === 'bar'
                ? <rect key={index} x={marker(index) + (column - series.length / 2) * barWidth} width={Math.max(1, barWidth - 2)}
                  y={Math.min(zero, y(value))} height={Math.max(1, Math.abs(zero - y(value)))} rx="2" data-value={value}>{title}</rect>
                : <circle key={index} cx={marker(index)} cy={y(value)} r="3.4" data-value={value}>{title}</circle>
            })}
          </g>
        })}
      </svg>
    </div>
    <figcaption>{series.map((item, index) => <span key={item.index} title={item.name}><i style={{ background: colors[index % colors.length] }}/>{item.name}</span>)}</figcaption>
  </figure>
}
