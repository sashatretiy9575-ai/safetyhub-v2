'use client';

/* eslint-disable @next/next/no-img-element */

import { useRef, useState } from 'react';
import { CheckCircle, DownloadSimple, Trash, UploadSimple, Warning } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { clientFetch } from '@/lib/client-request';

/** Mirrors `certificateSettingsSchema` on the server, minus the image bytes. */
export type CertificateSettingsView = {
  organizationName: string;
  bin: string;
  chairmanName: string;
  chairmanPosition: string;
  memberName: string;
  memberPosition: string;
  secondMemberName: string;
  secondMemberPosition: string;
  protocolNumber: string;
  validityMonths: number;
  examTextKk: string;
  examTextRu: string;
  knowledgeTextKk: string;
  knowledgeTextRu: string;
  hasStamp: boolean;
  hasChairmanSignature: boolean;
  hasMemberSignature: boolean;
  version: number;
  updatedAt: string;
};

type ImageKey = 'stampPng' | 'chairmanSignaturePng' | 'memberSignaturePng';
type ImageState = 'keep' | 'clear' | { dataUrl: string };

const IMAGE_MAX_BYTES = 400 * 1024;

const IMAGES: readonly {
  key: ImageKey;
  flag: 'hasStamp' | 'hasChairmanSignature' | 'hasMemberSignature';
  kind: 'stamp' | 'chairman' | 'member';
  title: string;
  hint: string;
}[] = [
  {
    key: 'stampPng',
    flag: 'hasStamp',
    kind: 'stamp',
    title: 'Печать организации',
    hint: 'Ставится на первой стороне у отметки М.О./М.П.',
  },
  {
    key: 'chairmanSignaturePng',
    flag: 'hasChairmanSignature',
    kind: 'chairman',
    title: 'Подпись председателя комиссии',
    hint: 'Над первой линией на второй стороне.',
  },
  {
    key: 'memberSignaturePng',
    flag: 'hasMemberSignature',
    kind: 'member',
    title: 'Подпись члена комиссии',
    hint: 'Над второй линией на второй стороне.',
  },
];

function readPng(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (file.type !== 'image/png') {
      reject(new Error('PNG_REQUIRED'));
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      reject(new Error('TOO_LARGE'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('READ_FAILED'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function fieldValues(settings: CertificateSettingsView) {
  return {
    organizationName: settings.organizationName,
    bin: settings.bin,
    chairmanName: settings.chairmanName,
    chairmanPosition: settings.chairmanPosition,
    memberName: settings.memberName,
    memberPosition: settings.memberPosition,
    secondMemberName: settings.secondMemberName,
    secondMemberPosition: settings.secondMemberPosition,
    protocolNumber: settings.protocolNumber,
    validityMonths: String(settings.validityMonths),
    examTextKk: settings.examTextKk,
    examTextRu: settings.examTextRu,
    knowledgeTextKk: settings.knowledgeTextKk,
    knowledgeTextRu: settings.knowledgeTextRu,
  };
}
type Fields = ReturnType<typeof fieldValues>;

/**
 * One form for the whole booklet. The administrator fills it in once; every
 * certificate downloaded afterwards, by anyone, is drawn with these values.
 */
export function CertificateSettingsForm({
  initialSettings,
}: {
  initialSettings: CertificateSettingsView;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [fields, setFields] = useState<Fields>(() => fieldValues(initialSettings));
  const [images, setImages] = useState<Record<ImageKey, ImageState>>({
    stampPng: 'keep',
    chairmanSignaturePng: 'keep',
    memberSignaturePng: 'keep',
  });
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle');
  const [message, setMessage] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false);
  const fileInputs = useRef<Partial<Record<ImageKey, HTMLInputElement | null>>>({});

  const validity = Number(fields.validityMonths);
  const validityValid = Number.isInteger(validity) && validity >= 0 && validity <= 120;
  const dirty =
    JSON.stringify(fields) !== JSON.stringify(fieldValues(settings)) ||
    Object.values(images).some((image) => image !== 'keep');

  const setField = (key: keyof Fields, value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setState('idle');
  };

  const pickImage = async (key: ImageKey, file: File | null) => {
    if (!file) return;
    try {
      const dataUrl = await readPng(file);
      setImages((current) => ({ ...current, [key]: { dataUrl } }));
      setState('idle');
      setMessage('');
    } catch (error) {
      setState('error');
      setMessage(
        error instanceof Error && error.message === 'TOO_LARGE'
          ? 'Файл больше 400 КБ. Уменьшите изображение и загрузите снова.'
          : 'Нужен файл PNG, лучше с прозрачным фоном.',
      );
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || !validityValid || state === 'saving') return;
    setState('saving');
    setMessage('');
    const patch: Record<string, unknown> = { expectedVersion: settings.version };
    const before = fieldValues(settings);
    for (const key of Object.keys(fields) as (keyof Fields)[]) {
      if (fields[key] !== before[key]) {
        patch[key] = key === 'validityMonths' ? validity : fields[key];
      }
    }
    for (const [key, image] of Object.entries(images) as [ImageKey, ImageState][]) {
      if (image === 'clear') patch[key] = null;
      else if (image !== 'keep') patch[key] = image.dataUrl;
    }
    try {
      const response = await clientFetch('/api/admin/settings/certificate', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        settings?: CertificateSettingsView;
      } | null;
      if (response.status === 409 && payload?.settings) {
        setSettings(payload.settings);
        setFields(fieldValues(payload.settings));
        setImages({ stampPng: 'keep', chairmanSignaturePng: 'keep', memberSignaturePng: 'keep' });
        setState('conflict');
        setMessage('Другой администратор уже изменил настройки. Показаны актуальные значения.');
        return;
      }
      if (!response.ok || !payload?.settings) {
        throw new Error(payload?.error ?? 'SAVE_FAILED');
      }
      setSettings(payload.settings);
      setFields(fieldValues(payload.settings));
      setImages({ stampPng: 'keep', chairmanSignaturePng: 'keep', memberSignaturePng: 'keep' });
      setState('saved');
      setMessage('Настройки сохранены. Все удостоверения теперь выдаются с ними.');
    } catch (error) {
      setState('error');
      setMessage(
        error instanceof Error && error.message === 'CERTIFICATE_IMAGE_INVALID'
          ? 'Одно из изображений не PNG или повреждено.'
          : 'Не удалось сохранить настройки. Проверьте соединение и повторите.',
      );
    }
  };

  const downloadSample = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    setMessage('');
    try {
      const response = await clientFetch('/api/admin/settings/certificate/sample', {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('SAMPLE_FAILED');
      const metadata = await response.json();
      const { downloadCertificateInBrowser } = await import('@/lib/pdf/certificate-client');
      await downloadCertificateInBrowser(metadata);
    } catch {
      setState('error');
      setMessage('Не удалось собрать образец. Сохраните настройки и попробуйте снова.');
    } finally {
      setSampleBusy(false);
    }
  };

  const textField = (
    key: keyof Fields,
    label: string,
    options: { placeholder?: string; hint?: string; maxLength?: number } = {},
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`certificate-${key}`}>{label}</Label>
      <Input
        id={`certificate-${key}`}
        value={fields[key]}
        maxLength={options.maxLength ?? 200}
        placeholder={options.placeholder}
        onChange={(event) => setField(key, event.target.value)}
      />
      {options.hint ? (
        <p className="text-xs text-[var(--color-text-muted)]">{options.hint}</p>
      ) : null}
    </div>
  );

  const textArea = (key: keyof Fields, label: string, hint: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`certificate-${key}`}>{label}</Label>
      <Textarea
        id={`certificate-${key}`}
        value={fields[key]}
        rows={3}
        maxLength={1000}
        onChange={(event) => setField(key, event.target.value)}
      />
      <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>
    </div>
  );

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-bold">Организация и комиссия</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Печатается на каждом удостоверении и в каждом протоколе. Пустое поле оставляет на бланке
            пустую линию.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {textField('organizationName', 'Учебная организация', {
            placeholder: 'SafetyHub',
            hint: 'Шапка протокола и строка «ЖШС / ТОО» на удостоверении.',
          })}
          {textField('bin', 'БСН / БИН', { placeholder: '123456789012', maxLength: 32 })}
          {textField('chairmanName', 'Председатель комиссии (Ф.И.О.)', {
            placeholder: 'Иванов И. И.',
          })}
          {textField('chairmanPosition', 'Должность председателя', {
            placeholder: 'Директор SafetyHub',
          })}
          {textField('memberName', 'Член комиссии (Ф.И.О.)', { placeholder: 'Петров П. П.' })}
          {textField('memberPosition', 'Должность члена комиссии', {
            placeholder: 'Преподаватель SafetyHub',
            hint: 'Этот член комиссии подписывает и удостоверение, и протокол.',
          })}
          {textField('secondMemberName', 'Второй член комиссии (Ф.И.О.)', {
            placeholder: 'Пусто — в протоколе один член комиссии',
          })}
          {textField('secondMemberPosition', 'Должность второго члена', {
            placeholder: 'Преподаватель SafetyHub',
          })}
          {textField('protocolNumber', 'Номер протокола', {
            placeholder: '1',
            maxLength: 64,
            hint: 'Подставляется вместо {protocol} в текстах ниже. Пусто — прочерк.',
          })}
          <div className="space-y-1.5">
            <Label htmlFor="certificate-validityMonths">Срок действия, месяцев</Label>
            <Input
              id="certificate-validityMonths"
              type="number"
              inputMode="numeric"
              min={0}
              max={120}
              value={fields.validityMonths}
              invalid={!validityValid}
              onChange={(event) => setField('validityMonths', event.target.value)}
            />
            <p className="text-xs text-[var(--color-text-muted)]">
              Считается от даты выдачи. 0 — строка «Действителен до» остаётся пустой.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-bold">Печать и подписи</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            PNG до 400 КБ, лучше с прозрачным фоном. Без файла место остаётся пустым.
          </p>
        </div>
        <div className="divide-y divide-[var(--color-border)]">
          {IMAGES.map(({ key, flag, kind, title, hint }) => {
            const image = images[key];
            const preview =
              image === 'clear'
                ? null
                : image === 'keep'
                  ? settings[flag]
                    ? `/certificate-assets/image?kind=${kind}&v=${settings.version}`
                    : null
                  : image.dataUrl;
            return (
              <div key={key} className="flex flex-wrap items-center gap-4 py-4">
                <div className="grid size-24 shrink-0 place-items-center rounded-xl bg-[var(--color-surface-muted)] p-2">
                  {preview ? (
                    <img
                      src={preview}
                      alt={title}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-[var(--color-text-subtle)]">Нет файла</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold">{title}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>
                </div>
                <input
                  ref={(element) => {
                    fileInputs.current[key] = element;
                  }}
                  type="file"
                  accept="image/png"
                  className="sr-only"
                  onChange={(event) => {
                    void pickImage(key, event.target.files?.[0] ?? null);
                    event.target.value = '';
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => fileInputs.current[key]?.click()}
                  >
                    <UploadSimple size={16} aria-hidden="true" />
                    {preview ? 'Заменить' : 'Загрузить PNG'}
                  </Button>
                  {preview ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => {
                        setImages((current) => ({ ...current, [key]: 'clear' }));
                        setState('idle');
                      }}
                    >
                      <Trash size={16} aria-hidden="true" />
                      Убрать
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-bold">Тексты бланка</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Как на бумажной корочке: две фразы на первой стороне и две на второй. Место для номера
            протокола обозначается как {'{protocol}'}.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {textArea('examTextKk', 'Первая сторона, казахский', 'Строка над русским текстом.')}
          {textArea(
            'examTextRu',
            'Первая сторона, русский',
            '«в том, что он (а) сдал (а) экзамены…»',
          )}
          {textArea(
            'knowledgeTextKk',
            'Вторая сторона, казахский',
            'Раздел «Білімін тексеру туралы мәліметтер».',
          )}
          {textArea(
            'knowledgeTextRu',
            'Вторая сторона, русский',
            'Раздел «Сведения о проверке знаний».',
          )}
        </div>
      </section>

      {message ? (
        <div
          role="status"
          className={`flex gap-2 rounded-xl border p-3 text-sm ${
            state === 'saved'
              ? 'border-[var(--color-success)]/35 bg-[var(--color-success)]/10'
              : 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10'
          }`}
        >
          {state === 'saved' ? <CheckCircle size={20} /> : <Warning size={20} />}
          <span>{message}</span>
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={sampleBusy || dirty}
          title={dirty ? 'Сначала сохраните изменения' : undefined}
          onClick={() => void downloadSample()}
        >
          <DownloadSimple size={18} aria-hidden="true" />
          {sampleBusy ? 'Собираем образец…' : 'Скачать образец (PDF)'}
        </Button>
        <Button
          type="submit"
          className="min-h-11"
          disabled={!dirty || !validityValid || state === 'saving'}
        >
          {state === 'saving' ? 'Сохраняем…' : 'Сохранить настройки'}
        </Button>
      </div>
    </form>
  );
}
