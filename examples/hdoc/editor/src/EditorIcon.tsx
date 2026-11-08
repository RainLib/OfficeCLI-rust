const paths = {
  undo:'M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14',
  redo:'m16 4 5 5-5 5m5-5H11a7 7 0 0 0 0 14',
  save: 'M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8',
  text: 'M4 5h16M12 5v15M8 20h8',
  image: 'M3 4h18v16H3V4Zm0 12 5-5 4 4 3-3 6 6M16 8h.01',
  fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8V8Z',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  panel: 'M3 4h18v16H3V4Zm12 0v16',
  slides: 'M7 3h14v14H7V3ZM3 7v14h14',
  focus: 'm3 8 5-5m8 0 5 5M3 16l5 5m8 0 5-5M3 3v5h5m8-5h5v5M3 16v5h5m8 0h5v-5',
  export: 'M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
} as const
export function isEditorIcon(name:string):name is keyof typeof paths{return Object.hasOwn(paths,name)}
export function EditorIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
