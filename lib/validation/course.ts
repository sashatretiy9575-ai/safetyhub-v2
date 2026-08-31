import { z } from 'zod';
import { articleBlocksSchema } from './article.ts';
import { contentSeoSchema } from './content-seo.ts';

const courseEntityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9-]+$/);

export const courseLessonSchema = z
  .object({
    id: courseEntityIdSchema,
    title: z.string().trim().min(2).max(180),
    blocks: articleBlocksSchema.min(1).max(50),
  })
  .strict();

export const courseModuleSchema = z
  .object({
    id: courseEntityIdSchema,
    title: z.string().trim().min(2).max(180),
    lessons: z.array(courseLessonSchema).min(1).max(30),
  })
  .strict();

export const courseContentSchema = z
  .object({ modules: z.array(courseModuleSchema).min(1).max(50) })
  .strict();

export const courseSeoSchema = contentSeoSchema;

export type CourseContent = z.infer<typeof courseContentSchema>;
export type CourseModule = z.infer<typeof courseModuleSchema>;
export type CourseLesson = z.infer<typeof courseLessonSchema>;

export function defaultCourseContent(title = '', description = ''): CourseContent {
  return {
    modules: [
      {
        id: 'module-main',
        title: title.trim() || 'Основной материал',
        lessons: [
          {
            id: 'lesson-introduction',
            title: title.trim() || 'Введение',
            blocks: [
              {
                type: 'paragraph',
                content: description.trim() || 'Добавьте содержание урока перед публикацией курса.',
              },
            ],
          },
        ],
      },
    ],
  };
}
