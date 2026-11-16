#ifdef GL_ES
precision mediump float;
#endif
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @label Mask strength
 * @default 0.32
 * @range 0, 1
 */
uniform float u_strength;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float wave = sin(uv.y * 12.0 + uv.x * 7.0 - u_time * 1.3);
  float sweep = pow(0.5 + 0.5 * sin((uv.x + uv.y * 0.35) * 8.0 - u_time * 2.0), 8.0);
  float falloff = smoothstep(0.0, 0.09, uv.x) * smoothstep(1.0, 0.91, uv.x)
                * smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.88, uv.y);
  vec3 color = mix(vec3(0.50, 0.58, 0.97), vec3(0.75, 0.65, 0.96), 0.5 + 0.5 * wave);
  float alpha = (0.10 + 0.48 * sweep) * falloff * u_strength;
  gl_FragColor = vec4(color * alpha, alpha);
}
