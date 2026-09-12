// Measures the certificate renderer the way the export worker runs it: one
// document after another, fonts served from the bundled assets. Prints the
// per-certificate time for a Cyrillic and a Chinese booklet, so a change to
// the renderer can be judged by numbers instead of a feeling.
//
// Usage: node scripts/bench-certificate-render.mjs [--count 20] [--images]
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { generateCertificateInBrowser } from '../lib/pdf/certificate-renderer.ts';

const count = Math.max(1, Number(process.argv[process.argv.indexOf('--count') + 1]) || 20);
const withImages = process.argv.includes('--images');

const branding = {
  organizationName: 'ТОО «Пример»',
  bin: '123456789012',
  chairmanName: 'Иванов И. И.',
  chairmanPosition: 'Директор SafetyHub',
  memberName: 'Петров П. П.',
  memberPosition: 'Преподаватель SafetyHub',
  secondMemberName: 'Сидоров С. С.',
  secondMemberPosition: 'Преподаватель SafetyHub',
  protocolNumber: '7',
  validityMonths: 12,
  examTextKk: '№{protocol} хаттама негіздемесі бойынша емтихан тапсырды',
  examTextRu: 'сдал экзамен на основании протокола №{protocol}',
  knowledgeTextKk: 'өрт қауіпсіздігі бойынша емтихан тапсырды',
  knowledgeTextRu: 'сдал экзамен по пожарной безопасности',
  stampUrl: withImages ? '/certificate-assets/image?kind=stamp&v=1' : null,
  chairmanSignatureUrl: withImages ? '/certificate-assets/image?kind=chairman&v=1' : null,
  memberSignatureUrl: withImages ? '/certificate-assets/image?kind=member&v=1' : null,
};

const base = {
  schemaVersion: 1,
  certificateId: '5f0c6f0e-5f2d-4f69-8a2e-34ac10f4892e',
  filename: 'SH-2026-ABC-Айжан.pdf',
  locale: 'ru',
  templateVersion: 1,
  titleSnapshot: 'Безопасность и охрана труда',
  templateUrl: '/certificates/template-v1.pdf',
  fontUrl: '/certificate-assets/font?locale=ru&v=1',
  fullName: 'Айжан Құсайынқызы',
  position: 'Инженер',
  organization: 'SafetyHub',
  score: 10,
  total: 10,
  passScore: 7,
  certificateNumber: 'SH-2026-ABC',
  completedAt: '2026-08-31T10:00:00.000Z',
  issuedAt: '2026-08-31T10:01:00.000Z',
  verificationUrl:
    'https://safetyhub.kz/verify/v1.5f0c6f0e-5f2d-4f69-8a2e-34ac10f4892e.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  branding,
};

const zh = {
  ...base,
  filename: 'SH-2026-ZH-张伟.pdf',
  locale: 'zh',
  titleSnapshot: '工业安全与劳动保护',
  fontUrl: '/certificate-assets/font?locale=zh&v=Sans2.005',
  fullName: '张伟',
  position: '安全工程师',
  organization: '哈萨克斯坦安全技术有限公司',
  certificateNumber: 'SH-2026-ZH-001',
};

// A 200x200 opaque PNG stands in for the stamp and both signatures.
function samplePng() {
  return import('@napi-rs/canvas').then(({ createCanvas }) => {
    const canvas = createCanvas(200, 200);
    const context = canvas.getContext('2d');
    context.fillStyle = '#1b5e3a';
    context.beginPath();
    context.arc(100, 100, 90, 0, Math.PI * 2);
    context.fill();
    return new Uint8Array(canvas.toBuffer('image/png'));
  });
}

const [latinFont, cjkFont, png] = await Promise.all([
  readFile(new URL('../lib/pdf/assets/noto-sans-latin-cyrillic.ttf', import.meta.url)),
  readFile(new URL('../lib/pdf/assets/NotoSansCJKsc-Regular-b2e9d66e.otf', import.meta.url)),
  withImages ? samplePng() : Promise.resolve(null),
]);
let fetches = 0;
globalThis.fetch = async (input) => {
  fetches += 1;
  const url = String(input);
  const body = url.includes('locale=zh')
    ? cjkFont
    : url.includes('/certificate-assets/font')
      ? latinFont
      : url.includes('/certificate-assets/image')
        ? png
        : null;
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.byteLength),
    },
  });
};

async function measure(label, metadata) {
  const durations = [];
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const output = await generateCertificateInBrowser({
      ...metadata,
      certificateNumber: `${metadata.certificateNumber}-${index}`,
      fullName: `${metadata.fullName} ${index}`,
    });
    durations.push(performance.now() - started);
    bytes = output.byteLength;
  }
  const ordered = [...durations].sort((left, right) => left - right);
  const p50 = ordered[Math.floor(ordered.length / 2)];
  const p95 = ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)];
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    label,
    count,
    firstMs: Number(durations[0].toFixed(1)),
    p50Ms: Number(p50.toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    totalMs: Number(total.toFixed(0)),
    pdfBytes: bytes,
  };
}

const results = [await measure('ru', base), await measure('zh', zh)];
console.log(JSON.stringify({ withImages, fetches, results }, null, 2));
