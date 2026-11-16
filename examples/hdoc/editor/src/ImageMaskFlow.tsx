import { useEffect, useRef } from 'react'
// Transparent WebGL surface: fragments outside the actual painted alpha discard.
export function ImageMaskFlow({ mask, active }: { mask: HTMLCanvasElement | null; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !mask || !active) return
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false })
    if (!gl) return
    canvas.width = Math.min(mask.width, 1600); canvas.height = Math.round(canvas.width * mask.height / mask.width)
    const compile = (type: number, source: string) => { const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('Shader compilation failed') } return shader }
    let frame = 0, texture: WebGLTexture | null = null, program: WebGLProgram | null = null
    const shaders: WebGLShader[] = []
    try {
      shaders.push(compile(gl.VERTEX_SHADER, 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,1.-(p.y+1.)*.5);gl_Position=vec4(p,0.,1.);}'))
      shaders.push(compile(gl.FRAGMENT_SHADER, 'precision mediump float;varying vec2 uv;uniform sampler2D mask;uniform float time;void main(){float a=texture2D(mask,uv).a;if(a<.004)discard;float v=.5+.5*sin(uv.x*16.+uv.y*10.-time*1.9+sin(uv.y*12.+time)*1.3);vec3 c=mix(vec3(.37,.40,.92),vec3(.72,.86,1.),v);gl_FragColor=vec4(c,a*(.22+v*.30));}'))
      program = gl.createProgram()!; shaders.forEach(s => gl.attachShader(program!, s)); gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed')
      gl.useProgram(program)
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const p = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(p); gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0)
      texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask)
      const time = gl.getUniformLocation(program, 'time'), reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      let last = 0
      const draw = (now: number) => { if (!document.hidden && canvas.getBoundingClientRect().width && now - last > 32) { last = now; gl.viewport(0, 0, canvas.width, canvas.height); gl.uniform1f(time, reduced ? 0 : now / 1000); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4) } if (!reduced) frame = requestAnimationFrame(draw) }
      frame = requestAnimationFrame(draw)
      return () => { cancelAnimationFrame(frame); gl.deleteTexture(texture); gl.deleteProgram(program); shaders.forEach(s => gl.deleteShader(s)); gl.deleteBuffer(buffer) }
    } catch { shaders.forEach(s => gl.deleteShader(s)); gl.deleteTexture(texture); gl.deleteProgram(program) }
  }, [mask, active])
  return <canvas ref={ref} className="image-mask-flow" aria-hidden="true" hidden={!active} />
}
