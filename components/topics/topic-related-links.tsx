import Link from '@/components/shared/navigation-link';
import { useTranslations } from 'next-intl';
import { Container } from '@/components/ui/container';
import { localizePathname, type AppLocale } from '@/i18n/config';

type LinkItem = Readonly<{ slug: string; title: string }>;

/**
 * Where to go from a course: the next courses of the catalogue and the latest
 * articles. A course page used to link out only to the catalogue, so neither a
 * reader nor a crawler found the material next to it.
 */
export function TopicRelatedLinks({
  locale,
  courses,
  articles,
}: {
  locale: AppLocale;
  courses: readonly LinkItem[];
  articles: readonly LinkItem[];
}) {
  const t = useTranslations('Topics');
  if (!courses.length && !articles.length) return null;
  const column = (title: string, base: '/topics' | '/blog', items: readonly LinkItem[]) =>
    items.length ? (
      <nav aria-label={title} className="min-w-0 space-y-2">
        <h2 className="text-sm font-bold">{title}</h2>
        <ul className="space-y-1.5 text-sm">
          {items.map((item) => (
            <li key={item.slug}>
              <Link
                href={localizePathname(`${base}/${item.slug}`, locale)}
                className="font-medium [overflow-wrap:anywhere] text-[var(--color-primary)] underline-offset-4 hover:underline"
              >
                {item.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    ) : null;

  return (
    <section className="py-5 md:py-7">
      <Container size="content">
        <div className="grid min-w-0 gap-6 sm:grid-cols-2">
          {column(t('relatedCourses'), '/topics', courses)}
          {column(t('relatedArticles'), '/blog', articles)}
        </div>
      </Container>
    </section>
  );
}
