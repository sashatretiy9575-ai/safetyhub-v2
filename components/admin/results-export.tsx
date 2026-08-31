'use client';

import { DownloadSimple } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

type Row = Record<string, unknown>;

export function ResultsExport({
  rows,
  filename = 'admin-data',
  label = 'Экспорт страницы (CSV)',
}: {
  rows: Row[];
  filename?: string;
  label?: string;
}) {
  const onExport = () => {
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0]!);
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
      const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
    ].join('\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Button variant="secondary" size="sm" onClick={onExport}>
      <DownloadSimple className="size-4" />
      {label}
    </Button>
  );
}
