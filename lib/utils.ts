import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { resolveSiteOrigin } from '@/lib/site-url';

const SAFETYHUB_TIME_ZONE = 'Asia/Oral';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPercent(value: number, locale = 'ru'): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value / 100);
}

export function formatScore(score: number, total: number): string {
  return `${score}/${total}`;
}

export function formatDate(date: Date | string, locale = 'ru'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: SAFETYHUB_TIME_ZONE,
  }).format(d);
}

export function formatDateTime(date: Date | string, locale = 'ru'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SAFETYHUB_TIME_ZONE,
  }).format(d);
}

export function generateCertificateNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SH-${year}-${random}`;
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const arr = [...items];
  let seedHash = 0;
  for (let i = 0; i < seed.length; i++) {
    seedHash = (seedHash << 5) - seedHash + seed.charCodeAt(i);
    seedHash |= 0;
  }
  let state = Math.abs(seedHash) || 1;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export function absoluteUrl(path: string): string {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${resolveSiteOrigin()}/`).toString();
}
