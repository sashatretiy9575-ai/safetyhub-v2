import { getImageProps } from 'next/image';
import Link from 'next/link';
import { ArrowRight, ChatCircleDots, MapPin } from '@phosphor-icons/react/dist/ssr';
import { Container } from '@/components/ui/container';
import { ROUTES } from '@/lib/constants';
import { getLocale, getTranslations } from 'next-intl/server';
import { QUIZ_POLICY } from '@/lib/constants';
import { localizePathname } from '@/i18n/config';

const HERO_IMAGES = {
  desktop: '/images/generated/hero-safetyhub-desktop-v2.webp',
  mobile: '/images/generated/hero-safetyhub-mobile-v2.webp',
} as const;

// Each branch of the <picture> gets the sizes that actually apply to it. The
// combined media query was correct on the <img> and absent from the <source>,
// so at desktop widths the browser had a srcSet with no sizes, assumed 100vw,
// picked the 1920w candidate — and the preload asked for a different one. The
// LCP image was fetched twice. `calc(100vw - 2rem)` is not understood by
// next/image, which then listed all sixteen widths in the mobile srcSet.
const MOBILE_SIZES = '100vw';
const DESKTOP_SIZES = '56vw';

function HeroPicture({ alt }: { alt: string }) {
  // No `priority` (deprecated in Next 16) and no preload of any kind: a
  // preload rendered by a Server Component — `preload()` or a <link> element —
  // becomes a hint in the route tree that every Home link prefetches, so every
  // other page downloaded the hero at high priority. The <picture> sits in the
  // first few kilobytes of the HTML, so the browser's preload scanner finds it
  // as early, and the <img> carries the high fetch priority itself.
  const common = {
    alt,
    fill: true,
    loading: 'eager',
    fetchPriority: 'high',
    quality: 82,
  } as const;
  const { props: mobileImageProps } = getImageProps({
    ...common,
    sizes: MOBILE_SIZES,
    src: HERO_IMAGES.mobile,
  });
  const { props: desktopImageProps } = getImageProps({
    ...common,
    sizes: DESKTOP_SIZES,
    src: HERO_IMAGES.desktop,
  });

  return (
    <picture>
      <source media="(min-width: 1024px)" srcSet={desktopImageProps.srcSet} sizes={DESKTOP_SIZES} />
      <img
        {...mobileImageProps}
        alt={alt}
        sizes={MOBILE_SIZES}
        fetchPriority="high"
        className="object-cover object-center"
      />
    </picture>
  );
}

export async function Hero() {
  const [t, locale] = await Promise.all([getTranslations('Home.hero'), getLocale()]);
  return (
    <section aria-labelledby="hero-heading" className="py-4 sm:py-7 lg:py-10">
      <Container size="wide">
        <div className="relative isolate grid overflow-hidden rounded-[28px] border border-[var(--color-border)] bg-[var(--color-surface)]/78 shadow-[0_24px_64px_-42px_rgba(15,23,18,0.38)] backdrop-blur-xl lg:min-h-[33rem] lg:grid-cols-[0.86fr_1.14fr] lg:rounded-[32px]">
          <div className="relative aspect-[16/9] min-h-0 overflow-hidden lg:order-2 lg:aspect-auto">
            <HeroPicture alt={t('imageAlt')} />
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-t from-black/15 to-transparent lg:bg-gradient-to-r lg:from-[var(--color-surface)]/15 lg:to-transparent"
            />
          </div>

          <div className="relative z-10 flex flex-col justify-center p-5 sm:p-8 lg:order-1 lg:p-11 xl:p-14">
            <span className="text-micro inline-flex w-fit items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/70 px-3 py-1.5 font-semibold tracking-widest text-[var(--color-text-muted)] uppercase backdrop-blur-xl sm:text-xs">
              <MapPin
                size={15}
                weight="duotone"
                className="text-[var(--color-primary)]"
                aria-hidden="true"
              />
              {t('eyebrow')}
            </span>
            <span
              aria-hidden="true"
              className="mt-5 h-1 w-10 rounded-full bg-[var(--color-primary)]/80"
            />
            <h1 id="hero-heading" className="text-display mt-3.5 max-w-xl font-bold text-balance">
              {t('title')}
            </h1>
            <p className="text-lead mt-4 max-w-xl text-[var(--color-text-muted)]">
              {t('description', { count: QUIZ_POLICY.questionCount, pass: QUIZ_POLICY.passScore })}
            </p>

            <div className="xs:grid-cols-2 mt-6 grid grid-cols-1 gap-2.5 sm:mt-7 sm:flex sm:flex-wrap sm:gap-3">
              <Link
                href={localizePathname(ROUTES.topics, locale)}
                className="text-caption inline-flex min-h-12 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-2.5 font-semibold text-[var(--color-primary-foreground)] transition hover:bg-[var(--color-primary-hover)] sm:min-h-[52px] sm:gap-2 sm:px-6 sm:text-sm"
              >
                {t('courses')}
                <ArrowRight size={17} weight="regular" aria-hidden="true" />
              </Link>
              <Link
                href={localizePathname(ROUTES.contacts, locale)}
                className="text-caption inline-flex min-h-12 items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 px-2.5 font-semibold text-[var(--color-text)] backdrop-blur-xl transition hover:bg-[var(--color-surface)] sm:min-h-[52px] sm:gap-2 sm:px-6 sm:text-sm"
              >
                <ChatCircleDots
                  size={18}
                  weight="regular"
                  className="text-[var(--color-primary)]"
                  aria-hidden="true"
                />
                {t('contact')}
              </Link>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
