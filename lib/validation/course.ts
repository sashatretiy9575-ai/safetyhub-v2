import * as z from 'zod/mini';
import { articleBlocksSchema } from './article.ts';
import { contentSeoSchema } from './content-seo.ts';

const courseEntityIdSchema = z
  .string()
  .check(z.trim(), z.minLength(1), z.maxLength(80), z.regex(/^[a-z0-9-]+$/));

const courseTitleSchema = z.string().check(z.trim(), z.minLength(2), z.maxLength(180));

export const courseLessonSchema = z.strictObject({
  id: courseEntityIdSchema,
  title: courseTitleSchema,
  blocks: articleBlocksSchema.check(z.minLength(1), z.maxLength(50)),
});

export const courseModuleSchema = z.strictObject({
  id: courseEntityIdSchema,
  title: courseTitleSchema,
  lessons: z.array(courseLessonSchema).check(z.minLength(1), z.maxLength(30)),
});

export const courseContentSchema = z.strictObject({
  modules: z.array(courseModuleSchema).check(z.minLength(1), z.maxLength(50)),
});

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
