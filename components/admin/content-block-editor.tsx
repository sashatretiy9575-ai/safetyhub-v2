'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, DotsSixVertical, Plus, Trash } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ArticleBlockInput } from '@/lib/validation/article';
import { MediaAssetInput } from '@/components/admin/media-asset-input';

const BLOCK_LABELS: Record<ArticleBlockInput['type'], string> = {
  paragraph: 'Абзац',
  heading: 'Заголовок',
  image: 'Изображение',
  button: 'Кнопка',
  slider: 'Галерея',
  quote: 'Цитата',
  list: 'Список',
  table: 'Таблица',
  callout: 'Заметка',
  source: 'Источник',
  divider: 'Разделитель',
};

const COURSE_BLOCK_TYPES: ArticleBlockInput['type'][] = [
  'paragraph',
  'heading',
  'list',
  'callout',
  'image',
  'slider',
  'table',
  'source',
  'divider',
];

const ARTICLE_BLOCK_TYPES: ArticleBlockInput['type'][] = [
  ...COURSE_BLOCK_TYPES.slice(0, 2),
  'button',
  'quote',
  ...COURSE_BLOCK_TYPES.slice(2),
];

function createBlock(type: ArticleBlockInput['type']): ArticleBlockInput {
  switch (type) {
    case 'paragraph':
      return { type, content: 'Новый абзац' };
    case 'heading':
      return { type, content: 'Новый раздел', level: 2 };
    case 'image':
      return {
        type,
        src: '/images/generated/article-occupational-safety.webp',
        alt: '',
        decorative: true,
      };
    case 'button':
      return { type, text: 'Подробнее', url: '/', style: 'primary' };
    case 'slider':
      return {
        type,
        label: 'Галерея материала',
        images: [
          {
            src: '/images/generated/article-occupational-safety.webp',
            alt: '',
            decorative: true,
          },
        ],
      };
    case 'quote':
      return { type, content: 'Важная цитата' };
    case 'list':
      return { type, style: 'unordered', items: ['Первый пункт'] };
    case 'table':
      return { type, caption: 'Сравнение', headers: ['Параметр', 'Значение'], rows: [['', '']] };
    case 'callout':
      return { type, tone: 'info', title: 'Важно', content: 'Добавьте пояснение.' };
    case 'source':
      return { type, title: 'Нормативный источник', url: 'https://adilet.zan.kz/' };
    case 'divider':
      return { type };
  }
}

function replaceBlock(blocks: ArticleBlockInput[], index: number, next: ArticleBlockInput) {
  return blocks.map((block, blockIndex) => (blockIndex === index ? next : block));
}

export function ContentBlockEditor({
  blocks,
  onChange,
  mode = 'course',
}: {
  blocks: ArticleBlockInput[];
  onChange: (blocks: ArticleBlockInput[]) => void;
  mode?: 'course' | 'article';
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const update = (index: number, next: ArticleBlockInput) =>
    onChange(replaceBlock(blocks, index, next));

  const moveTo = (index: number, target: number) => {
    if (target < 0 || target >= blocks.length || index === target) return;
    const next = [...blocks];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    onChange(next);
  };

  const move = (index: number, offset: -1 | 1) => moveTo(index, index + offset);
  const allowedTypes = mode === 'article' ? ARTICLE_BLOCK_TYPES : COURSE_BLOCK_TYPES;

  return (
    <div className="space-y-3">
      {blocks.map((block, index) => (
        <fieldset
          key={`${block.type}-${index}`}
          className="min-w-0 space-y-3 rounded-xl border border-transparent bg-[var(--color-surface-muted)]/55 p-3 transition-colors focus-within:border-[var(--color-primary)]/55 focus-within:bg-[var(--color-surface)]"
          onDragOver={(event) => {
            if (draggedIndex === null || draggedIndex === index) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = Number(event.dataTransfer.getData('text/plain'));
            if (Number.isInteger(source)) moveTo(source, index);
            setDraggedIndex(null);
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)]/40 pb-2">
            <legend className="px-1 text-sm font-bold">
              Блок {index + 1} · {BLOCK_LABELS[block.type]}
            </legend>
            <div className="flex items-center gap-0.5 sm:gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              draggable
              aria-label={`Перетащить блок ${index + 1}`}
              className="cursor-grab active:cursor-grabbing"
              onDragStart={(event) => {
                setDraggedIndex(index);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
              }}
              onDragEnd={() => setDraggedIndex(null)}
            >
              <DotsSixVertical />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={index === 0}
              aria-label="Переместить блок выше"
              onClick={() => move(index, -1)}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={index === blocks.length - 1}
              aria-label="Переместить блок ниже"
              onClick={() => move(index, 1)}
            >
              <ArrowDown />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Дублировать блок"
              onClick={() =>
                onChange([
                  ...blocks.slice(0, index + 1),
                  structuredClone(block),
                  ...blocks.slice(index + 1),
                ])
              }
            >
              <Copy />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-[var(--color-danger)]"
              aria-label="Удалить блок"
              disabled={blocks.length === 1}
              onClick={() =>
                window.confirm(`Удалить блок ${index + 1}?`) &&
                onChange(blocks.filter((_, blockIndex) => blockIndex !== index))
              }
            >
              <Trash />
            </Button>
          </div>
        </div>

          {block.type === 'paragraph' || block.type === 'quote' ? (
            <Textarea
              aria-label={BLOCK_LABELS[block.type]}
              value={block.content}
              onChange={(event) => update(index, { ...block, content: event.target.value })}
              className="min-h-28"
            />
          ) : null}

          {block.type === 'heading' ? (
            <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
              <select
                aria-label="Уровень заголовка"
                value={block.level}
                onChange={(event) =>
                  update(index, { ...block, level: Number(event.target.value) as 2 | 3 | 4 })
                }
                className="min-h-11 rounded-lg border bg-[var(--color-surface)] px-3"
              >
                <option value={2}>H2</option>
                <option value={3}>H3</option>
                <option value={4}>H4</option>
              </select>
              <Input
                aria-label="Текст заголовка"
                value={block.content}
                onChange={(event) => update(index, { ...block, content: event.target.value })}
              />
            </div>
          ) : null}

          {block.type === 'list' ? (
            <div className="space-y-2">
              <select
                aria-label="Вид списка"
                value={block.style}
                onChange={(event) =>
                  update(index, { ...block, style: event.target.value as 'ordered' | 'unordered' })
                }
                className="min-h-11 rounded-lg border bg-[var(--color-surface)] px-3"
              >
                <option value="unordered">Маркированный</option>
                <option value="ordered">Нумерованный</option>
              </select>
              <Textarea
                aria-label="Пункты списка, по одному на строку"
                value={block.items.join('\n')}
                onChange={(event) =>
                  update(index, { ...block, items: event.target.value.split('\n') })
                }
              />
            </div>
          ) : null}

          {block.type === 'callout' ? (
            <div className="grid gap-2">
              <select
                aria-label="Тип заметки"
                value={block.tone}
                onChange={(event) =>
                  update(index, {
                    ...block,
                    tone: event.target.value as 'info' | 'warning' | 'success',
                  })
                }
                className="min-h-11 rounded-lg border bg-[var(--color-surface)] px-3"
              >
                <option value="info">Информация</option>
                <option value="warning">Предупреждение</option>
                <option value="success">Рекомендация</option>
              </select>
              <Input
                aria-label="Заголовок заметки"
                value={block.title ?? ''}
                onChange={(event) =>
                  update(index, { ...block, title: event.target.value || undefined })
                }
              />
              <Textarea
                aria-label="Текст заметки"
                value={block.content}
                onChange={(event) => update(index, { ...block, content: event.target.value })}
              />
            </div>
          ) : null}

          {block.type === 'image' ? (
            <div className="grid gap-2">
              <Label htmlFor={`course-image-${index}`}>Изображение</Label>
              <MediaAssetInput
                id={`course-image-${index}`}
                value={block.src}
                maxWidth={1600}
                maxHeight={1200}
                onChange={(src) => update(index, { ...block, src })}
              />
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={block.decorative}
                  onChange={(event) =>
                    update(index, {
                      ...block,
                      decorative: event.target.checked,
                      alt: event.target.checked ? '' : block.alt,
                    })
                  }
                  className="size-5"
                />
                Декоративное изображение
              </label>
              <Input
                aria-label="Alt-текст изображения"
                disabled={block.decorative}
                value={block.alt}
                onChange={(event) => update(index, { ...block, alt: event.target.value })}
              />
              <Input
                aria-label="Подпись изображения"
                value={block.caption ?? ''}
                onChange={(event) =>
                  update(index, { ...block, caption: event.target.value || undefined })
                }
              />
            </div>
          ) : null}

          {block.type === 'slider' ? (
            <div className="grid gap-2">
              <Input
                aria-label="Название галереи"
                value={block.label ?? ''}
                onChange={(event) =>
                  update(index, { ...block, label: event.target.value || undefined })
                }
              />
              {block.images.map((image, imageIndex) => (
                <fieldset
                  key={imageIndex}
                  className="grid gap-2 rounded-lg bg-[var(--color-surface)] p-3 outline outline-1 outline-transparent focus-within:outline-[var(--color-primary)]/45"
                >
                  <legend className="px-1 text-xs font-bold">Изображение {imageIndex + 1}</legend>
                  <MediaAssetInput
                    value={image.src}
                    ariaLabel={`Путь изображения ${imageIndex + 1}`}
                    maxWidth={1200}
                    maxHeight={900}
                    onChange={(src) =>
                      update(index, {
                        ...block,
                        images: block.images.map((current, currentIndex) =>
                          currentIndex === imageIndex ? { ...current, src } : current,
                        ),
                      })
                    }
                  />
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={image.decorative}
                      onChange={(event) =>
                        update(index, {
                          ...block,
                          images: block.images.map((current, currentIndex) =>
                            currentIndex === imageIndex
                              ? {
                                  ...current,
                                  decorative: event.target.checked,
                                  alt: event.target.checked ? '' : current.alt,
                                }
                              : current,
                          ),
                        })
                      }
                      className="size-5"
                    />
                    Декоративное изображение
                  </label>
                  <Input
                    aria-label={`Alt-текст изображения ${imageIndex + 1}`}
                    disabled={image.decorative}
                    value={image.alt}
                    onChange={(event) =>
                      update(index, {
                        ...block,
                        images: block.images.map((current, currentIndex) =>
                          currentIndex === imageIndex
                            ? { ...current, alt: event.target.value }
                            : current,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={`Подпись изображения ${imageIndex + 1}`}
                    value={image.caption ?? ''}
                    onChange={(event) =>
                      update(index, {
                        ...block,
                        images: block.images.map((current, currentIndex) =>
                          currentIndex === imageIndex
                            ? { ...current, caption: event.target.value || undefined }
                            : current,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={block.images.length === 1}
                    onClick={() =>
                      update(index, {
                        ...block,
                        images: block.images.filter(
                          (_, currentIndex) => currentIndex !== imageIndex,
                        ),
                      })
                    }
                  >
                    <Trash /> Удалить изображение
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  update(index, {
                    ...block,
                    images: [...block.images, { src: '', alt: '', decorative: false }],
                  })
                }
              >
                <Plus /> Добавить изображение
              </Button>
            </div>
          ) : null}

          {block.type === 'button' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                aria-label="Текст кнопки"
                value={block.text}
                onChange={(event) => update(index, { ...block, text: event.target.value })}
              />
              <Input
                aria-label="URL кнопки"
                value={block.url}
                onChange={(event) => update(index, { ...block, url: event.target.value })}
              />
              <select
                aria-label="Стиль кнопки"
                value={block.style}
                onChange={(event) =>
                  update(index, {
                    ...block,
                    style: event.target.value as 'primary' | 'outline',
                  })
                }
                className="min-h-11 rounded-lg border bg-[var(--color-surface)] px-3"
              >
                <option value="primary">Основная</option>
                <option value="outline">Контурная</option>
              </select>
            </div>
          ) : null}

          {block.type === 'table' ? (
            <div className="grid gap-2">
              <Input
                aria-label="Подпись таблицы"
                value={block.caption ?? ''}
                onChange={(event) =>
                  update(index, { ...block, caption: event.target.value || undefined })
                }
              />
              <Input
                aria-label="Заголовки таблицы"
                value={block.headers.join('|')}
                onChange={(event) =>
                  update(index, { ...block, headers: event.target.value.split('|') })
                }
              />
              <Textarea
                aria-label="Строки таблицы"
                value={block.rows.map((row) => row.join('|')).join('\n')}
                onChange={(event) =>
                  update(index, {
                    ...block,
                    rows: event.target.value.split('\n').map((row) => row.split('|')),
                  })
                }
              />
            </div>
          ) : null}

          {block.type === 'source' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                aria-label="Название источника"
                value={block.title}
                onChange={(event) => update(index, { ...block, title: event.target.value })}
              />
              <Input
                aria-label="URL источника"
                type="url"
                value={block.url}
                onChange={(event) => update(index, { ...block, url: event.target.value })}
              />
              <Textarea
                aria-label="Примечание к источнику"
                className="sm:col-span-2"
                value={block.note ?? ''}
                onChange={(event) =>
                  update(index, { ...block, note: event.target.value || undefined })
                }
              />
            </div>
          ) : null}
        </fieldset>
      ))}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2" aria-label="Добавить блок">
        {allowedTypes.map((type) => (
          <Button
            key={type}
            type="button"
            size="sm"
            variant="outline"
            className="w-full justify-start text-xs font-semibold"
            onClick={() => onChange([...blocks, createBlock(type)])}
          >
            <Plus /> {BLOCK_LABELS[type]}
          </Button>
        ))}
      </div>
    </div>
  );
}
