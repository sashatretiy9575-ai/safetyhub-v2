'use client';

import { ArrowDown, ArrowUp, Copy, Plus, Trash } from '@phosphor-icons/react';
import { ContentBlockEditor } from '@/components/admin/content-block-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CourseContent } from '@/lib/validation/course';

function entityId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function CourseContentEditor({
  value,
  onChange,
}: {
  value: CourseContent;
  onChange: (value: CourseContent) => void;
}) {
  const updateModule = (moduleIndex: number, update: Partial<CourseContent['modules'][number]>) =>
    onChange({
      modules: value.modules.map((module, index) =>
        index === moduleIndex ? { ...module, ...update } : module,
      ),
    });

  return (
    <div id="test-content" className="space-y-4">
      {value.modules.map((module, moduleIndex) => (
        <section
          key={module.id}
          className="space-y-4 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/45 p-3 first:border-t-0 md:p-5"
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={`module-${module.id}`}>Название модуля</Label>
              <Input
                id={`module-${module.id}`}
                value={module.title}
                onChange={(event) => updateModule(moduleIndex, { title: event.target.value })}
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={moduleIndex === 0}
              aria-label="Переместить модуль выше"
              onClick={() => {
                const modules = [...value.modules];
                [modules[moduleIndex - 1], modules[moduleIndex]] = [
                  modules[moduleIndex]!,
                  modules[moduleIndex - 1]!,
                ];
                onChange({ modules });
              }}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={moduleIndex === value.modules.length - 1}
              aria-label="Переместить модуль ниже"
              onClick={() => {
                const modules = [...value.modules];
                [modules[moduleIndex], modules[moduleIndex + 1]] = [
                  modules[moduleIndex + 1]!,
                  modules[moduleIndex]!,
                ];
                onChange({ modules });
              }}
            >
              <ArrowDown />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-[var(--color-danger)]"
              disabled={value.modules.length === 1}
              aria-label="Удалить модуль"
              onClick={() =>
                window.confirm('Удалить модуль и все его уроки?') &&
                onChange({ modules: value.modules.filter((_, index) => index !== moduleIndex) })
              }
            >
              <Trash />
            </Button>
          </div>

          {module.lessons.map((lesson, lessonIndex) => (
            <fieldset
              key={lesson.id}
              className="min-w-0 space-y-4 rounded-xl bg-[var(--color-surface)] p-3 md:p-4"
            >
              <legend className="px-1 text-sm font-bold">Урок {lessonIndex + 1}</legend>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor={`lesson-${lesson.id}`}>Название урока</Label>
                  <Input
                    id={`lesson-${lesson.id}`}
                    value={lesson.title}
                    onChange={(event) =>
                      updateModule(moduleIndex, {
                        lessons: module.lessons.map((item, index) =>
                          index === lessonIndex ? { ...item, title: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={lessonIndex === 0}
                  aria-label="Переместить урок выше"
                  onClick={() => {
                    const lessons = [...module.lessons];
                    [lessons[lessonIndex - 1], lessons[lessonIndex]] = [
                      lessons[lessonIndex]!,
                      lessons[lessonIndex - 1]!,
                    ];
                    updateModule(moduleIndex, { lessons });
                  }}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={lessonIndex === module.lessons.length - 1}
                  aria-label="Переместить урок ниже"
                  onClick={() => {
                    const lessons = [...module.lessons];
                    [lessons[lessonIndex], lessons[lessonIndex + 1]] = [
                      lessons[lessonIndex + 1]!,
                      lessons[lessonIndex]!,
                    ];
                    updateModule(moduleIndex, { lessons });
                  }}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Дублировать урок"
                  onClick={() => {
                    const clone = structuredClone(lesson);
                    clone.id = entityId('lesson');
                    updateModule(moduleIndex, {
                      lessons: [
                        ...module.lessons.slice(0, lessonIndex + 1),
                        clone,
                        ...module.lessons.slice(lessonIndex + 1),
                      ],
                    });
                  }}
                >
                  <Copy />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-[var(--color-danger)]"
                  disabled={module.lessons.length === 1}
                  aria-label="Удалить урок"
                  onClick={() =>
                    window.confirm('Удалить урок?') &&
                    updateModule(moduleIndex, {
                      lessons: module.lessons.filter((_, index) => index !== lessonIndex),
                    })
                  }
                >
                  <Trash />
                </Button>
              </div>
              <ContentBlockEditor
                blocks={lesson.blocks}
                onChange={(blocks) =>
                  updateModule(moduleIndex, {
                    lessons: module.lessons.map((item, index) =>
                      index === lessonIndex ? { ...item, blocks } : item,
                    ),
                  })
                }
              />
            </fieldset>
          ))}

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              updateModule(moduleIndex, {
                lessons: [
                  ...module.lessons,
                  {
                    id: entityId('lesson'),
                    title: 'Новый урок',
                    blocks: [{ type: 'paragraph', content: 'Добавьте материал урока.' }],
                  },
                ],
              })
            }
          >
            <Plus /> Добавить урок
          </Button>
        </section>
      ))}

      <Button
        type="button"
        variant="outline"
        onClick={() =>
          onChange({
            modules: [
              ...value.modules,
              {
                id: entityId('module'),
                title: 'Новый модуль',
                lessons: [
                  {
                    id: entityId('lesson'),
                    title: 'Новый урок',
                    blocks: [{ type: 'paragraph', content: 'Добавьте материал урока.' }],
                  },
                ],
              },
            ],
          })
        }
      >
        <Plus /> Добавить модуль
      </Button>
    </div>
  );
}
