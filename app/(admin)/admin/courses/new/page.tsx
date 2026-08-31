import { requireCapability } from '@/features/auth/server';
import { TestEditor } from '@/components/admin/test-editor';

export default async function NewCoursePage() {
  await requireCapability('test.manage');
  return (
    <section className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold">Новый курс</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Создайте черновик, загрузите PDF и заполните три варианта по десять вопросов.
        </p>
      </div>
      <TestEditor />
    </section>
  );
}
