import type { CanvasScene } from './model.ts'

/** Native canvas assets share the existing Agent resource tab. */
export function CanvasResources({ scene }: { scene: CanvasScene | null }) {
  const images = scene?.elements.filter(element => element.type === 'image' && !element.isDeleted) || []
  return <section className="canvas-resources" aria-label="画布图片资源">
    <h3>画布中的图片</h3>
    {images.length ? <div>{images.map((element, index) => {
      const file = scene?.files[String(element.fileId)]
      return <figure key={element.id}>{file && <img src={file.dataURL} alt={`画布图片 ${index + 1}`} />}<figcaption>图片 {index + 1}<small>{Math.round(Math.abs(element.width))} × {Math.round(Math.abs(element.height))}</small></figcaption></figure>
    })}</div> : <p>使用画布工具栏插入图片后，可以在这里查看。</p>}
  </section>
}
