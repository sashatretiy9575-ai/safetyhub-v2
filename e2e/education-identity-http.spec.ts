import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

if (process.env.E2E_EDUCATION_HTTP === '1') {
  test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE });

  test('real identity HTTP education refusal is atomic and corrected reissue preserves history', async ({
    request,
    page,
  }, testInfo) => {
    const base = String(testInfo.project.use.baseURL);
    const databaseUrl =
      process.env.SAFETYHUB_LOCAL_DATABASE_URL ??
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    expect(['localhost', '127.0.0.1']).toContain(new URL(base).hostname);
    expect(['localhost', '127.0.0.1']).toContain(
      new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname,
    );
    expect(databaseUrl).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    const pg = createRequire(import.meta.url)('pg');
    const db = new pg.Client({ connectionString: databaseUrl });
    const learner = randomUUID();
    await db.connect();
    let primaryError: unknown;
    try {
      await db.query(
        await readFile(
          new URL('./helpers/education-identity-fixture.sql', import.meta.url),
          'utf8',
        ),
      );
      const original = (
        await db.query('select * from pg_temp.document_certificate_fixture($1)', [learner])
      ).rows[0];
      expect(original.document_snapshot.profile.family).toBe('general');
      await db.query('update public.profiles set avatar_updated_at=now() where id=$1', [learner]);
      const state = async () =>
        (
          await db.query(
            `select to_jsonb(p) as profile, to_jsonb(i) as identity,
      (select jsonb_agg(to_jsonb(c) order by c.issued_at,c.id) from public.certificates c where c.user_id=p.id) as certificates
      from public.profiles p join public.verified_identities i on i.user_id=p.id where p.id=$1`,
            [learner],
          )
        ).rows[0];
      const before = await state();
      const route = '/api/admin/users/' + learner + '/identity';
      const fields = {
        action: 'verify',
        name: 'Исправленный',
        surname: before.profile.surname,
        job: before.profile.job,
        organization: before.profile.organization,
        education: '',
      };
      const refused = await request.patch(route, { headers: { origin: base }, data: fields });
      const refusalBody = await refused.text();
      expect(refused.status(), refusalBody).toBe(409);
      expect(JSON.parse(refusalBody)).toEqual({
        error: 'DOCUMENT_REQUIRED_FIELDS',
        fields: ['education'],
      });
      expect(
        await state(),
        'Rejected correction must not change profile, identity or any certificate',
      ).toEqual(before);

      const accepted = await request.patch(route, {
        headers: { origin: base },
        data: { ...fields, education: 'Высшее' },
      });
      expect(accepted.status(), await accepted.text()).toBe(200);
      const after = await state();
      expect(after.profile.name).toBe(fields.name);
      expect(after.profile.education).toBe('Высшее');
      expect(after.identity.name).toBe(fields.name);
      expect(after.identity.version).toBe(before.identity.version + 1);
      expect(after.certificates).toHaveLength(2);
      const old = after.certificates.find(
        (certificate: { id: string }) => certificate.id === original.id,
      );
      const current = after.certificates.find(
        (certificate: { revoked_at: string | null }) => !certificate.revoked_at,
      );
      expect(old.revoked_at).not.toBeNull();
      expect(old.document_snapshot).toEqual(before.certificates[0].document_snapshot);
      expect(current.supersedes_certificate_id).toBe(original.id);
      expect(current.document_snapshot.education).toBe('Высшее');
      expect(current.full_name).toContain(fields.name);
      expect(current.identity_version).toBe(after.identity.version);
      // The old certificate stays available while an improved result awaits issuance.
      expect(current.score).toBeLessThan(current.total);
      await db.query('update public.test_attempts set score=$2 where id=$1 and user_id=$3', [
        current.attempt_id,
        current.score + 1,
        learner,
      ]);
      await db.query('update public.attestations set best_score=$2 where id=$1 and user_id=$3', [
        current.attestation_id,
        current.score + 1,
        learner,
      ]);
      await page.goto(
        '/admin/employees?' + new URLSearchParams({ q: before.profile.organization }),
      );
      await expect(
        page.locator('[data-attestations-manager]').filter({ visible: true }),
      ).toHaveAttribute('data-client-ready', 'true');
      await page.getByRole('button', { name: /^Открыть сведения:/u }).click();
      const card = page.getByRole('dialog');
      await expect(
        card.getByRole('button', { name: 'Выдать по улучшенному результату', exact: true }),
      ).toBeVisible();
      await expect(card.getByText('Результат улучшен', { exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: /Скачать PDF/ })).toBeVisible();
      await card.getByRole('button', { name: 'Закрыть', exact: true }).click();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await db.query(
          await readFile(
            new URL('./helpers/education-identity-cleanup.sql', import.meta.url),
            'utf8',
          ),
        );
        await db.query('select pg_temp.cleanup_document_certificate_fixture($1)', [learner]);
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        await testInfo.attach('fixture-cleanup-error', {
          body: String(cleanupError),
          contentType: 'text/plain',
        });
      } finally {
        await db.end();
      }
    }
  });
}
