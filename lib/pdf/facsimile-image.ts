/**
 * A stamp or a signature is ink on paper; a document needs the ink alone.
 * This turns a scan or a phone photograph into a transparent picture without
 * a server and without a canvas, so the editor, the build script and the
 * tests share one implementation.
 */
export type RgbaImage = Readonly<{ data: Uint8ClampedArray | Uint8Array; width: number; height: number }>;

/** The long side the stored picture is brought to: over 450 dpi of a 40 mm stamp. */
export const FACSIMILE_TARGET_SIDE = 720;
/** Larger sources are reduced before the paper is measured; nothing is gained above this. */
export const FACSIMILE_SOURCE_SIDE = 1000;
const MAX_UPSCALE = 6;
/** The darkest channel of full-density ink: deep, but still a colour rather than black. */
const INK_DEPTH = 28;
/** A scan greys every colour; this share of the grey is taken back out. Black ink stays black. */
const INK_GREY_REMOVED = 0.6;

/** A picture that already has a cut-out background is left exactly as drawn. */
export function hasTransparency(image: RgbaImage): boolean {
  const pixels = image.width * image.height;
  let clear = 0;
  for (let i = 3; i < pixels * 4; i += 4) if (image.data[i]! < 128) clear++;
  return clear > pixels * 0.02;
}

function maxFilter(source: Float32Array, width: number, height: number, radius: number) {
  const rows = new Float32Array(width * height);
  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let best = 0;
    for (let k = Math.max(0, x - radius), end = Math.min(width - 1, x + radius); k <= end; k++) best = Math.max(best, source[y * width + k]!);
    rows[y * width + x] = best;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let best = 0;
    for (let k = Math.max(0, y - radius), end = Math.min(height - 1, y + radius); k <= end; k++) best = Math.max(best, rows[k * width + x]!);
    result[y * width + x] = best;
  }
  return result;
}

function boxBlur(source: Float32Array, width: number, height: number, radius: number) {
  if (radius < 1) return source;
  const rows = new Float32Array(width * height);
  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0, count = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x++) { sum += source[y * width + x]!; count++; }
    for (let x = 0; x < width; x++) {
      rows[y * width + x] = sum / count;
      const enter = x + radius + 1, leave = x - radius;
      if (enter < width) { sum += source[y * width + enter]!; count++; }
      if (leave >= 0) { sum -= source[y * width + leave]!; count--; }
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y++) { sum += rows[y * width + x]!; count++; }
    for (let y = 0; y < height; y++) {
      result[y * width + x] = sum / count;
      const enter = y + radius + 1, leave = y - radius;
      if (enter < height) { sum += rows[enter * width + x]!; count++; }
      if (leave >= 0) { sum -= rows[leave * width + x]!; count--; }
    }
  }
  return result;
}

const cubic = (t: number) => {
  const a = Math.abs(t);
  return a <= 1 ? 1.5 * a * a * a - 2.5 * a * a + 1 : a < 2 ? -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2 : 0;
};

/** Catmull-Rom resampling of one channel; pen strokes stay smooth when a small scan is enlarged. */
function resample(source: Float32Array, width: number, height: number, nextWidth: number, nextHeight: number) {
  const pass = (input: Float32Array, length: number, nextLength: number, stride: number, lines: number, lineStride: number, output: Float32Array, outStride: number, outLineStride: number) => {
    const ratio = length / nextLength;
    // Reducing needs a wider kernel, or thin lines alias away.
    const support = Math.max(1, ratio);
    for (let i = 0; i < nextLength; i++) {
      const centre = (i + 0.5) * ratio - 0.5;
      const first = Math.floor(centre - 2 * support) + 1, last = Math.floor(centre + 2 * support);
      const weights: number[] = [];
      let total = 0;
      for (let k = first; k <= last; k++) { const w = cubic((k - centre) / support); weights.push(w); total += w; }
      for (let line = 0; line < lines; line++) {
        let value = 0;
        for (let k = first; k <= last; k++) value += input[line * lineStride + Math.min(length - 1, Math.max(0, k)) * stride]! * weights[k - first]!;
        output[line * outLineStride + i * outStride] = value / total;
      }
    }
  };
  const horizontal = new Float32Array(nextWidth * height);
  pass(source, width, nextWidth, 1, height, width, horizontal, 1, nextWidth);
  const result = new Float32Array(nextWidth * nextHeight);
  pass(horizontal, height, nextHeight, nextWidth, nextWidth, 1, result, nextWidth, 1);
  return result;
}

function percentile(values: Float32Array, floor: number, fraction: number) {
  const histogram = new Uint32Array(256);
  let total = 0;
  for (const value of values) if (value > floor) { histogram[Math.min(255, Math.round(value * 255))]!++; total++; }
  if (!total) return 0;
  let seen = 0;
  for (let bin = 0; bin < 256; bin++) { seen += histogram[bin]!; if (seen >= total * fraction) return bin / 255; }
  return 1;
}

/**
 * Ink on paper becomes ink on nothing: the paper is measured around every
 * pixel (a phone photograph is never evenly lit), whatever is darker than its
 * paper is ink, the empty margin is cut off, a small scan is enlarged with
 * smooth edges, and the ink keeps one colour — its own.
 */
export function extractInk(image: RgbaImage, targetSide = FACSIMILE_TARGET_SIDE): RgbaImage | null {
  const { width, height, data } = image;
  if (width < 8 || height < 8) return null;
  const darkness = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) darkness[i] = Math.min(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
  // Strokes are thinner than this window, so its brightest pixel is paper.
  const radius = Math.max(8, Math.round(Math.max(width, height) / 40));
  const paper = boxBlur(maxFilter(darkness, width, height, radius), width, height, radius);
  const ink = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) ink[i] = Math.max(0, (paper[i]! - darkness[i]!) / Math.max(paper[i]!, 1));
  // A pale stamp and a black pen both end up fully opaque where they are densest.
  const dense = percentile(ink, 0.08, 0.9);
  if (dense < 0.1) return null;
  const gain = Math.min(4, Math.max(1, 0.95 / dense));
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (ink[y * width + x]! * gain < 0.35) continue;
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
  }
  if (right < left || bottom < top) return null;
  const pad = Math.max(2, Math.round(Math.max(right - left, bottom - top) * 0.03));
  left = Math.max(0, left - pad); top = Math.max(0, top - pad); right = Math.min(width - 1, right + pad); bottom = Math.min(height - 1, bottom + pad);
  const cropWidth = right - left + 1, cropHeight = bottom - top + 1;
  const cropped = new Float32Array(cropWidth * cropHeight);
  // What the ink took out of the paper's light, channel by channel, is its hue.
  const absorbed = [0, 0, 0];
  for (let y = 0; y < cropHeight; y++) for (let x = 0; x < cropWidth; x++) {
    const from = (y + top) * width + x + left, value = Math.min(1, ink[from]! * gain);
    cropped[y * cropWidth + x] = value;
    if (value > 0.8) for (let c = 0; c < 3; c++) absorbed[c]! += Math.max(0, paper[from]! - data[from * 4 + c]!);
  }
  const scale = Math.min(MAX_UPSCALE, targetSide / Math.max(cropWidth, cropHeight));
  const nextWidth = Math.max(1, Math.round(cropWidth * scale)), nextHeight = Math.max(1, Math.round(cropHeight * scale));
  const resized = scale === 1 ? cropped : resample(cropped, cropWidth, cropHeight, nextWidth, nextHeight);
  // Enlarged pixels are rounded off before the edge is drawn, or they show as stairs.
  const smooth = scale > 1.5 ? boxBlur(boxBlur(resized, nextWidth, nextHeight, Math.round(scale * 0.3)), nextWidth, nextHeight, Math.round(scale * 0.3)) : resized;
  // A scanner sees pale ink through the paper's glare; printed at full density
  // the same hue is as deep as a fresh impression.
  const grey = Math.min(absorbed[0]!, absorbed[1]!, absorbed[2]!) * INK_GREY_REMOVED;
  const strongest = Math.max(absorbed[0]!, absorbed[1]!, absorbed[2]!) - grey || 1;
  const colour = absorbed.map((channel) => Math.round(255 - ((channel - grey) / strongest) * (255 - INK_DEPTH)));
  const result = new Uint8ClampedArray(nextWidth * nextHeight * 4);
  for (let i = 0; i < nextWidth * nextHeight; i++) {
    const t = Math.min(1, Math.max(0, (smooth[i]! - 0.12) / 0.58));
    result[i * 4] = colour[0]!; result[i * 4 + 1] = colour[1]!; result[i * 4 + 2] = colour[2]!;
    result[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return { data: result, width: nextWidth, height: nextHeight };
}
