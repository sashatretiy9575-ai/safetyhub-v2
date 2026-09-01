'use client';

import Script from 'next/script';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useCspNonce } from '@/features/auth/csp-nonce';

type TurnstileSize = 'compact' | 'flexible';
type TurnstileFailure = 'error' | 'expired' | 'unsupported';

export type TurnstileHandle = {
  execute: () => void;
};

const TURNSTILE_SCRIPT_ID = 'cloudflare-turnstile-api';

declare global {
  interface Window {
    turnstile?: {
      execute: (widgetId: string) => void;
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

export const Turnstile = forwardRef<
  TurnstileHandle,
  {
    onToken: (token: string | null) => void;
    onFailure?: (failure: TurnstileFailure) => void;
  }
>(
  function Turnstile({ onToken, onFailure }, ref) {
    const locale = useLocale();
    const t = useTranslations('AuthOtp');
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    const nonce = useCspNonce();
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetRef = useRef<string | null>(null);
    const sizeRef = useRef<TurnstileSize>('compact');
    const onTokenRef = useRef(onToken);
    const onFailureRef = useRef(onFailure);
    const pendingExecutionRef = useRef(false);
    const completedRef = useRef(false);
    const resetRequiredRef = useRef(false);
    const [activated, setActivated] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<TurnstileFailure | null>(null);

    useEffect(() => {
      onTokenRef.current = onToken;
    }, [onToken]);

    useEffect(() => {
      onFailureRef.current = onFailure;
    }, [onFailure]);

    const failVerification = useCallback((nextFailure: TurnstileFailure) => {
      pendingExecutionRef.current = false;
      completedRef.current = false;
      resetRequiredRef.current = true;
      setBusy(false);
      setFailure(nextFailure);
      onTokenRef.current(null);
      onFailureRef.current?.(nextFailure);
    }, []);

    const executeNativeWidget = useCallback(
      (widgetId: string) => {
        if (!window.turnstile) return;
        setBusy(true);
        setFailure(null);
        onTokenRef.current(null);
        try {
          window.turnstile.execute(widgetId);
        } catch {
          failVerification('error');
        }
      },
      [failVerification],
    );

    const renderWidget = useCallback(() => {
      const container = containerRef.current;
      if (!activated || !siteKey || !container || !window.turnstile || widgetRef.current) return;

      const size: TurnstileSize =
        container.getBoundingClientRect().width >= 300 ? 'flexible' : 'compact';
      sizeRef.current = size;
      container.dataset.turnstileSize = size;

      try {
        const widgetId = window.turnstile.render(container, {
          sitekey: siteKey,
          theme: 'auto',
          language: locale === 'zh' ? 'zh-CN' : locale,
          size,
          execution: 'execute',
          appearance: 'always',
          retry: 'never',
          'refresh-expired': 'manual',
          'refresh-timeout': 'manual',
          callback: (token: string) => {
            pendingExecutionRef.current = false;
            completedRef.current = true;
            resetRequiredRef.current = false;
            setBusy(false);
            setFailure(null);
            onTokenRef.current(token);
          },
          'before-interactive-callback': () => setBusy(true),
          'expired-callback': () => failVerification('expired'),
          'timeout-callback': () => failVerification('error'),
          'error-callback': () => failVerification('error'),
          'unsupported-callback': () => failVerification('unsupported'),
        });
        widgetRef.current = widgetId;
        if (pendingExecutionRef.current) executeNativeWidget(widgetId);
      } catch {
        failVerification('error');
      }
    }, [activated, executeNativeWidget, failVerification, locale, siteKey]);

    const execute = useCallback(() => {
      if (!siteKey || pendingExecutionRef.current || completedRef.current) return;
      pendingExecutionRef.current = true;
      setFailure(null);
      setActivated(true);
      const widgetId = widgetRef.current;
      if (widgetId) {
        if (resetRequiredRef.current && window.turnstile) {
          window.turnstile.reset(widgetId);
          resetRequiredRef.current = false;
        }
        executeNativeWidget(widgetId);
      }
    }, [executeNativeWidget, siteKey]);

    useImperativeHandle(ref, () => ({ execute }), [execute]);

    useEffect(() => {
      if (!siteKey || !activated) return;
      const container = containerRef.current;
      if (!container) return;

      renderWidget();
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextSize: TurnstileSize = entry.contentRect.width >= 300 ? 'flexible' : 'compact';
        container.dataset.turnstileSize = nextSize;
        if (nextSize === sizeRef.current || !widgetRef.current || !window.turnstile) return;

        const shouldExecute = pendingExecutionRef.current;
        window.turnstile.remove(widgetRef.current);
        widgetRef.current = null;
        sizeRef.current = nextSize;
        onTokenRef.current(null);
        pendingExecutionRef.current = shouldExecute;
        renderWidget();
      });
      observer.observe(container);

      return () => {
        observer.disconnect();
        if (widgetRef.current && window.turnstile) window.turnstile.remove(widgetRef.current);
        widgetRef.current = null;
      };
    }, [activated, renderWidget, siteKey]);

    if (!siteKey || !activated) return null;

    return (
      <div className="w-full min-w-0 space-y-2" aria-busy={busy}>
        <Script
          id={TURNSTILE_SCRIPT_ID}
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          nonce={nonce}
          onReady={renderWidget}
          onError={() => failVerification('error')}
        />
        <div
          ref={containerRef}
          tabIndex={-1}
          className="flex min-h-[65px] w-full min-w-0 justify-center rounded-[var(--radius-md)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
          role="group"
          aria-label={t('captchaAria')}
        />
        {failure ? (
          <p
            role="alert"
            className="flex items-center justify-between gap-3 text-sm text-[var(--color-danger)]"
          >
            <span>{t(`turnstile.${failure}`)}</span>
            <button
              type="button"
              onClick={execute}
              className="min-h-10 shrink-0 rounded-lg px-2 font-bold underline underline-offset-4 focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
            >
              {t('turnstile.retry')}
            </button>
          </p>
        ) : null}
      </div>
    );
  },
);
