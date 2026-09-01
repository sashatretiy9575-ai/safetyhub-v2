import { ImageResponse } from 'next/og';

export const alt = 'SafetyHub.kz';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 84px',
        color: '#ffffff',
        background: 'linear-gradient(135deg, #0b0d0c 0%, #123c23 58%, #1f9f4a 100%)',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 24, fontSize: 42, fontWeight: 800 }}
      >
        <div
          style={{
            width: 72,
            height: 72,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 24,
            background: '#24c963',
            color: '#07150c',
            fontSize: 28,
            fontWeight: 900,
          }}
        >
          SH
        </div>
        SafetyHub.kz
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ maxWidth: 980, fontSize: 68, lineHeight: 1.06, fontWeight: 900 }}>
          SafetyHub.kz
        </div>
        <div style={{ fontSize: 28, color: '#d7f5e1' }}>RU · KK · EN · 中文</div>
      </div>
    </div>,
    size,
  );
}
