'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MediaAssetInput } from '@/components/admin/media-asset-input';
import type { ContentSeo } from '@/lib/validation/content-seo';
import { cn } from '@/lib/utils';

export function ContentSeoEditor({
  idPrefix,
  value,
  onChange,
  className,
  imageLabel = 'Open Graph изображение',
  imageHint,
}: {
  idPrefix: string;
  value: ContentSeo;
  onChange: (value: ContentSeo) => void;
  className?: string;
  /** A course has no cover field of its own, so this image is also its catalog
   *  cover. Naming it accordingly is the only way an editor can tell. */
  imageLabel?: string;
  imageHint?: string;
}) {
  const update = <Key extends keyof ContentSeo>(key: Key, next: ContentSeo[Key]) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <div className={cn('grid gap-4 md:grid-cols-2', className)}>
      <div className="space-y-1.5">
        <Label className="sr-only" htmlFor={`${idPrefix}-seo-title`}>SEO-заголовок</Label>
        <Input
          placeholder="SEO-заголовок"
          id={`${idPrefix}-seo-title`}
          maxLength={70}
          value={value.title}
          onChange={(event) => update('title', event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="sr-only" htmlFor={`${idPrefix}-og-title`}>Open Graph заголовок</Label>
        <Input
          placeholder="Open Graph заголовок"
          id={`${idPrefix}-og-title`}
          maxLength={70}
          value={value.ogTitle}
          onChange={(event) => update('ogTitle', event.target.value)}
        />
      </div>
      <div className="space-y-1.5 md:col-span-2">
        <Label className="sr-only" htmlFor={`${idPrefix}-seo-description`}>SEO-описание</Label>
        <Textarea
          placeholder="SEO-описание"
          id={`${idPrefix}-seo-description`}
          maxLength={200}
          value={value.description}
          onChange={(event) => update('description', event.target.value)}
        />
      </div>
      <div className="space-y-1.5 md:col-span-2">
        <Label className="sr-only" htmlFor={`${idPrefix}-og-description`}>Open Graph описание</Label>
        <Textarea
          placeholder="Open Graph описание"
          id={`${idPrefix}-og-description`}
          maxLength={200}
          value={value.ogDescription}
          onChange={(event) => update('ogDescription', event.target.value)}
        />
      </div>
      <div className="space-y-1.5 md:col-span-2" title={imageHint}>
        <Label className="sr-only" htmlFor={`${idPrefix}-og-image`}>
          {imageLabel}
        </Label>
        <MediaAssetInput
          id={`${idPrefix}-og-image`}
          value={value.ogImage}
          placeholder={imageLabel}
          maxWidth={1200}
          maxHeight={630}
          onChange={(ogImage) => update('ogImage', ogImage)}
        />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium md:col-span-2">
        <input
          type="checkbox"
          className="size-5"
          checked={value.indexable}
          onChange={(event) => update('indexable', event.target.checked)}
        />
        Разрешить индексацию после публикации
      </label>
    </div>
  );
}
