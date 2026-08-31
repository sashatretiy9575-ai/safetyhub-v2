import { Container } from '@/components/ui/container';
import type { Topic } from '@/lib/content/topics';

export function TopicSourcesCard({ topic }: { topic: Pick<Topic, 'sources'> }) {
  if (topic.sources.length === 0) return null;

  return (
    <section id="topic-sources" aria-label="Источники материала" className="py-5 md:py-7">
      <Container size="content">
        <div className="space-y-3">
          <details className="group rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-muted)]">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-bold marker:content-none md:px-5 [&::-webkit-details-marker]:hidden">
              <span>Нормативные источники ({topic.sources.length})</span>
              <span
                aria-hidden="true"
                className="text-xl text-[var(--color-primary)] transition-transform group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <div className="border-t border-[var(--color-border)] px-4 py-4 md:px-5">
              <ul className="space-y-2 text-sm">
                {topic.sources.map((source) => (
                  <li key={source.url}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-[var(--color-primary)] underline underline-offset-4"
                    >
                      {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      </Container>
    </section>
  );
}
