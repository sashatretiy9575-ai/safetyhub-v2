import { requireCapability } from '@/server/auth/session';
import { TestEditor } from '@/components/admin/test-editor';

export default async function NewCoursePage() {
  await requireCapability('test.manage');
  return (
    <section className="space-y-6">
      <div>
        <h1 className="font-display text-h3 font-bold">Новый курс</h1>
      </div>
      <TestEditor />
    </section>
  );
}
