#ifdef GL_ES
precision mediump float;
#endif
/** @resolution */
uniform vec2 u_resolution;
/** @label Source image */
uniform sampler2D u_image;
/** @label Warmth
 * @default 0.3
 * @range 0, 1
 */
uniform float u_warmth;
void main() {
  vec4 src = texture2D(u_image, gl_FragCoord.xy / u_resolution);
  vec3 c = src.rgb / max(src.a, 0.0001);
  c = pow(max(c, vec3(0.0)), vec3(0.94));
  c *= vec3(1.0 + u_warmth * 0.12, 1.0 + u_warmth * 0.03, 1.0 - u_warmth * 0.08);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 0.96);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
}
