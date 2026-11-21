#ifdef GL_ES
precision mediump float;
#endif
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @label Painted mask */
uniform sampler2D u_mask;
/** @label Generation state
 * @default 0
 * @range 0, 1
 */
uniform float u_generating;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float mask = texture2D(u_mask, uv).a;
  float sweep = pow(0.5 + 0.5 * sin(uv.x * 18.0 + uv.y * 10.0 - u_time * 2.2), 5.0);
  float alpha = mask * (0.35 + u_generating * sweep * 0.30);
  vec3 tint = mix(vec3(0.58, 0.48, 0.94), vec3(0.77, 0.69, 0.99), sweep * u_generating);
  gl_FragColor = vec4(tint * alpha, alpha);
}
