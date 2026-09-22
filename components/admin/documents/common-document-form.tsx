'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FloppyDisk, Plus, Trash } from '@phosphor-icons/react';
import { useUnsavedChangesGuard } from '@/components/admin/use-unsaved-changes-guard';
import { FRAME_INPUT, FrameWord, WordFrame } from '@/components/admin/word-frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { clientFetch } from '@/lib/client-request';
import { INSERT_SIZE_LIMITS, insertSizeProblem } from '@/lib/pdf/document-editor';
import { retryAfterSeconds } from '@/lib/pdf/document-preview-job';
import {
  DOCUMENT_STAMP_OWNER,
  newDocumentSignerId,
  type BookletTexts,
  type DocumentCommission,
} from '@/lib/pdf/document-profile';
import type { CertificateSettings } from '@/server/certificates/settings';
import { FacsimileUploadTile } from './facsimile-upload-tile';

const FIELD_INPUT = 'min-h-12 min-w-0 w-full text-base';
const FIELD_TEXTAREA = 'min-w-0 w-full text-base';
const MAX_SIGNERS = 6;
const BOOKLET_FIELDS: readonly { key: keyof BookletTexts; label: string }[] = [
  { key: 'examTextKk', label: 'Левая сторона, казахский' },
  { key: 'knowledgeTextKk', label: 'Правая сторона, казахский' },
  { key: 'examTextRu', label: 'Левая сторона, русский' },
  { key: 'knowledgeTextRu', label: 'Правая сторона, русский' },
];

type Fields = {
  organizationName: string;
  bin: string;
  reviewerName: string;
  booklet: BookletTexts;
  insertWidthCm: number | null;
  insertHeightCm: number | null;
  commission: DocumentCommission;
};

function fieldsOf(settings: CertificateSettings): Fields {
  return {
    organizationName: settings.organizationName,
    bin: settings.bin,
    reviewerName: settings.documentDefaults.reviewerName,
    booklet: {
      examTextKk: settings.examTextKk,
      examTextRu: settings.examTextRu,
      knowledgeTextKk: settings.knowledgeTextKk,
      knowledgeTextRu: settings.knowledgeTextRu,
    },
    insertWidthCm: settings.documentDefaults.insertWidthCm ?? null,
    insertHeightCm: settings.documentDefaults.insertHeightCm ?? null,
    commission: settings.documentCommission ?? { signers: [], stampAssetId: null },
  };
}

/** Why «Общее» cannot be sent, or null. */
function fieldsProblem(fields: Fields) {
  if (!fields.commission.signers.length) return 'Добавьте председателя комиссии';
  if (fields.commission.signers.some((signer) => !signer.name.trim())) return 'Укажите ФИО в комиссии';
  const size = insertSizeProblem(fields);
  if (size) {
    const [min, max] = INSERT_SIZE_LIMITS[size];
    return `${size === 'insertWidthCm' ? 'Ширина' : 'Высота'} корочки: от ${min} до ${max} см`;
  }
  return null;
}

/** The patch «Сохранить» sends: every field of the page, and the legacy copies kept in step. */
function patchOf(settings: CertificateSettings, fields: Fields) {
  const signers = fields.commission.signers.map((signer) => ({
    ...signer,
    name: signer.name.trim(),
    position: signer.position.trim(),
  }));
  const [chairman, ...members] = signers;
  return {
    organizationName: fields.organizationName.trim(),
    bin: fields.bin.trim(),
    chairmanName: chairman?.name ?? '',
    chairmanPosition: chairman?.position ?? '',
    ...fields.booklet,
    documentDefaults: {
      ...settings.documentDefaults,
      reviewerName: fields.reviewerName.trim(),
      commission: members.map(({ name, position }) => ({ name, position })),
      insertWidthCm: fields.insertWidthCm,
      insertHeightCm: fields.insertHeightCm,
    },
    documentCommission: { signers, stampAssetId: fields.commission.stampAssetId },
    expectedVersion: settings.version,
  };
}

type Answer = { settings?: CertificateSettings; error?: string; retryAfter?: number };

/**
 * «Общее»: what every course prints alike — the training centre, its seal, the
 * commission with the signatures of its members, and the booklet every course
 * prints unless it has its own. One «Сохранить» for all of it.
 */
export function CommonDocumentForm({ settings: initialSettings }: { settings: CertificateSettings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [fields, setFields] = useState(() => fieldsOf(initialSettings));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const dirty = JSON.stringify(fields) !== JSON.stringify(fieldsOf(settings));
  useUnsavedChangesGuard(dirty, { title: 'Уйти без сохранения?' });
  const signers = fields.commission.signers;

  const update = (patch: Partial<Fields>) => {
    setStatus('');
    setFields((current) => ({ ...current, ...patch }));
  };
  const updateCommission = (patch: Partial<DocumentCommission>) =>
    update({ commission: { ...fields.commission, ...patch } });
  const updateSigner = (index: number, patch: Partial<DocumentCommission['signers'][number]>) =>
    updateCommission({
      signers: signers.map((signer, at) => (at === index ? { ...signer, ...patch } : signer)),
    });

  async function save() {
    const problem = fieldsProblem(fields);
    if (problem) {
      setStatus(problem);
      return;
    }
    setBusy(true);
    setStatus('Сохраняем…');
    try {
      const response = await clientFetch('/api/admin/settings/certificate', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patchOf(settings, fields)),
      });
      const answer = (await response.json().catch(() => null)) as Answer | null;
      if (response.ok && answer?.settings) {
        setSettings(answer.settings);
        setFields(fieldsOf(answer.settings));
        setStatus('Сохранено');
        return;
      }
      if (response.status === 409) {
        setStatus('Сохранено в другом окне — обновите страницу');
        return;
      }
      if (response.status === 429) {
        const seconds = retryAfterSeconds(
          answer?.retryAfter ? String(answer.retryAfter) : response.headers.get('Retry-After'),
        );
        setStatus(`Повторите через ${seconds} с`);
        return;
      }
      setStatus(response.status === 400 ? 'Проверьте поля' : 'Не сохранилось, повторите');
    } catch {
      setStatus('Не сохранилось, повторите');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="document-editor mx-auto min-w-0 max-w-4xl space-y-4"
      data-hydrated={hydrated ? '' : undefined}
    >
      <div
        data-documents-bar
        className="sticky top-[calc(3.5rem+var(--safe-area-top))] z-[var(--z-sticky)] border-y border-[var(--color-border-strong)] bg-[var(--color-surface)]/96 px-3 py-2 shadow-[var(--shadow-card)] backdrop-blur-xl md:rounded-[var(--radius-lg)] md:border-x lg:top-4"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild size="icon" variant="ghost">
            <Link href="/admin/documents" aria-label="К документам">
              <ArrowLeft aria-hidden="true" />
            </Link>
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">Общее</h1>
          <p role="status" className="hidden min-w-0 truncate text-sm text-[var(--color-text-muted)] sm:block">
            {status}
          </p>
          <Button size="sm" aria-label="Сохранить" disabled={busy || !dirty} onClick={() => void save()}>
            <FloppyDisk aria-hidden="true" />
            <span className="hidden sm:inline">Сохранить</span>
          </Button>
        </div>
        <p role="status" className="min-h-5 truncate pt-1 text-sm text-[var(--color-text-muted)] sm:hidden">
          {status}
        </p>
      </div>

      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div className="grid min-w-0 content-start gap-3">
            <Input
              aria-label="Учебная организация"
              placeholder="Учебная организация"
              maxLength={200}
              className={FIELD_INPUT}
              value={fields.organizationName}
              onChange={(event) => update({ organizationName: event.target.value })}
            />
            <div className="xs:grid-cols-2 grid min-w-0 gap-3">
              <Input
                aria-label="БИН"
                placeholder="БИН"
                maxLength={32}
                className={FIELD_INPUT}
                value={fields.bin}
                onChange={(event) => update({ bin: event.target.value })}
              />
              <Input
                aria-label="Проверяющий"
                placeholder="Проверяющий"
                maxLength={200}
                className={FIELD_INPUT}
                value={fields.reviewerName}
                onChange={(event) => update({ reviewerName: event.target.value })}
              />
            </div>
          </div>
          <FacsimileUploadTile
            ownerId={DOCUMENT_STAMP_OWNER}
            kind="stamp"
            label="Печать"
            placeholder="Печать"
            assetId={fields.commission.stampAssetId}
            disabled={busy}
            className="w-40"
            onUploaded={(assetId) => updateCommission({ stampAssetId: assetId })}
          />
        </div>

        <section aria-labelledby="documents-commission" className="min-w-0 space-y-3">
          <h2 id="documents-commission" className="text-lg font-bold">
            Комиссия
          </h2>
          {signers.map((signer, index) => (
            <div
              key={signer.signerId}
              className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]"
            >
              <FacsimileUploadTile
                ownerId={signer.signerId}
                kind="signature"
                label={`Подпись: ${signer.name || (index ? 'член комиссии' : 'председатель')}`}
                placeholder="Подпись"
                assetId={signer.assetId}
                disabled={busy}
                onUploaded={(assetId) => updateSigner(index, { assetId })}
              />
              <div className="flex min-w-0 items-start gap-1">
                <div className="grid min-w-0 flex-1 gap-3">
                  <Input
                    aria-label={index ? `Член комиссии ${index}` : 'Председатель'}
                    placeholder={index ? 'Член комиссии' : 'Председатель'}
                    maxLength={200}
                    className={FIELD_INPUT}
                    value={signer.name}
                    onChange={(event) => updateSigner(index, { name: event.target.value })}
                  />
                  <Input
                    aria-label={index ? `Должность члена комиссии ${index}` : 'Должность председателя'}
                    placeholder="Должность"
                    maxLength={200}
                    className={FIELD_INPUT}
                    value={signer.position}
                    onChange={(event) => updateSigner(index, { position: event.target.value })}
                  />
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="mt-1.5 hover:text-[var(--color-danger)]"
                  aria-label={`Убрать из комиссии: ${signer.name || (index ? 'член комиссии' : 'председатель')}`}
                  title="Убрать"
                  disabled={signers.length <= 1}
                  onClick={() =>
                    updateCommission({ signers: signers.filter((_, at) => at !== index) })
                  }
                >
                  <Trash aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Добавить в комиссию"
            title="Добавить"
            disabled={signers.length >= MAX_SIGNERS}
            onClick={() =>
              updateCommission({
                signers: [
                  ...signers,
                  { signerId: newDocumentSignerId(), name: '', position: '', assetId: null },
                ],
              })
            }
          >
            <Plus aria-hidden="true" />
          </Button>
        </section>

        <section aria-labelledby="documents-booklet" className="min-w-0 space-y-3">
          <h2 id="documents-booklet" className="text-lg font-bold">
            Корочка
          </h2>
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {BOOKLET_FIELDS.map(({ key, label }) => (
              <Textarea
                key={key}
                aria-label={label}
                placeholder={label}
                maxLength={1000}
                rows={4}
                className={FIELD_TEXTAREA}
                value={fields.booklet[key]}
                onChange={(event) =>
                  update({ booklet: { ...fields.booklet, [key]: event.target.value } })
                }
              />
            ))}
          </div>
          <div className="xs:grid-cols-2 grid min-w-0 gap-3">
            {(['insertWidthCm', 'insertHeightCm'] as const).map((key) => (
              <WordFrame key={key}>
                <FrameWord>{key === 'insertWidthCm' ? 'ширина' : 'высота'}</FrameWord>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min={INSERT_SIZE_LIMITS[key][0]}
                  max={INSERT_SIZE_LIMITS[key][1]}
                  aria-label={key === 'insertWidthCm' ? 'Ширина разворота, см' : 'Высота, см'}
                  className={FRAME_INPUT}
                  value={fields[key] ?? ''}
                  onChange={(event) =>
                    update({ [key]: event.target.value === '' ? null : Number(event.target.value) })
                  }
                />
                <FrameWord>см</FrameWord>
              </WordFrame>
            ))}
          </div>
        </section>
      </fieldset>
    </div>
  );
}
