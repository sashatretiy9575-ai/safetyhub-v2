'use client';

import { useEffect } from 'react';

export function PWARegistration() {
  useEffect(() => {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return;

    const register = () => {
      void navigator.serviceWorker
        .register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        })
        .then((registration) => registration.update())
        .catch(() => {
          // The site remains fully usable when service workers are unavailable.
        });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
