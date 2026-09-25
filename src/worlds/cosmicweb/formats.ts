/**
 * Render-target formats for the cosmic-web renderer (module: cosmos), chosen for portability.
 *
 * WebGL2 facts this relies on (Khronos WebGL 2.0 spec + extension registry):
 *  - Float colour attachments are renderable only with EXT_color_buffer_float (R16F…RGBA32F) or,
 *    on some mobile GPUs, EXT_color_buffer_half_float (16-bit formats only).
 *  - Blending into 32-bit float attachments additionally needs EXT_float_blend; 16-bit float
 *    attachments blend without it.
 *  - LINEAR filtering of 32-bit float textures needs OES_texture_float_linear (missing on iOS and
 *    many Android GPUs — sampling such a texture with LINEAR then returns black); 16-bit float
 *    textures are always filterable.
 * So the light accumulator (sampled with LINEAR filtering when it is smaller than the screen) is
 * half float, never float32, and the density atlas (texelFetch only) uses float32 only where
 * float32 blending exists. Without any float colour buffers everything falls back to 8-bit
 * targets with scaled encodings (degraded precision, but never black).
 */
export type AccumMode = 'rg16f' | 'rgba16f' | 'rgba8';
export type AtlasMode = 'r32f' | 'r16f' | 'rgba16f' | 'rgba8';

export interface GLCaps {
  colorBufferFloat: boolean;
  colorBufferHalfFloat: boolean;
  floatBlend: boolean;
}

export interface WebFormats {
  accum: AccumMode;
  atlas: AtlasMode;
}

export function chooseFormats(c: GLCaps): WebFormats {
  const accum: AccumMode = c.colorBufferFloat ? 'rg16f' : c.colorBufferHalfFloat ? 'rgba16f' : 'rgba8';
  const atlas: AtlasMode = c.colorBufferFloat ? (c.floatBlend ? 'r32f' : 'r16f') : c.colorBufferHalfFloat ? 'rgba16f' : 'rgba8';
  return { accum, atlas };
}

/** Next format to try if `m` turns out not to be framebuffer-complete on this device. */
export function fallbackAccum(m: AccumMode): AccumMode | null {
  return m === 'rg16f' ? 'rgba16f' : m === 'rgba16f' ? 'rgba8' : null;
}
export function fallbackAtlas(m: AtlasMode): AtlasMode | null {
  return m === 'r32f' ? 'r16f' : m === 'r16f' ? 'rgba16f' : m === 'rgba16f' ? 'rgba8' : null;
}

/** three.js constants (numeric, so this module needs no three import in tests). */
const HALF_FLOAT = 1016, FLOAT = 1015, UNSIGNED_BYTE = 1009;
const RED = 1028, RG = 1030, RGBA = 1023;
const LINEAR = 1006, NEAREST = 1003;

export interface TargetSpec {
  type: number;
  format: number;
  filter: number;
  /** Multiplier applied before storing (8-bit encodings keep sums inside [0, 1]); 1 for float. */
  encode: number;
}

export function accumSpec(m: AccumMode): TargetSpec {
  if (m === 'rg16f') return { type: HALF_FLOAT, format: RG, filter: LINEAR, encode: 1 };
  if (m === 'rgba16f') return { type: HALF_FLOAT, format: RGBA, filter: LINEAR, encode: 1 };
  // 8-bit: sums saturate at 4 (asinh-stretched, that is already bright); the accumulation shader
  // adds ±½ LSB of noise (stochastic rounding) so faint sprites are not rounded away.
  return { type: UNSIGNED_BYTE, format: RGBA, filter: LINEAR, encode: 1 / 4 };
}

export function atlasSpec(m: AtlasMode): TargetSpec {
  if (m === 'r32f') return { type: FLOAT, format: RED, filter: NEAREST, encode: 1 };
  if (m === 'r16f') return { type: HALF_FLOAT, format: RED, filter: NEAREST, encode: 1 };
  if (m === 'rgba16f') return { type: HALF_FLOAT, format: RGBA, filter: NEAREST, encode: 1 };
  // 8-bit: ρ/ρ̄ saturates at 32 (only cluster cores); one particle adds ≥ 3 LSB, so rounding stays small.
  return { type: UNSIGNED_BYTE, format: RGBA, filter: NEAREST, encode: 1 / 32 };
}

/**
 * Light-accumulator resolution relative to the HDR target. The accumulated dark-matter light is a
 * smooth field (every sprite carries an SPH kernel at least ~1 CSS px wide), so it is rendered at
 * no more than one pixel per CSS pixel and upsampled bilinearly by the composite: on a DPR-2 screen
 * that is a quarter of the sprite fragments for the same image. Lower tiers render coarser still.
 */
export function accumScaleFor(detail: number, pixelRatio: number): number {
  const tier = detail >= 1 ? 1 : detail >= 0.6 ? 0.85 : 0.7;
  return tier / Math.max(1, pixelRatio);
}
