import { requireCapability } from '@/server/auth/session';
import { TestEditor } from '@/components/admin/test-editor';

export default async function NewCoursePage() {
  await requireCapability('test.manage');
  return (
    <section className="space-y-6">
      <TestEditor
        heading={<h1 className="font-display text-h3 font-bold break-words">Новый курс</h1>}
      />
    </section>
  );
}
