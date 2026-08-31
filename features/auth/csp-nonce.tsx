'use client';

import { createContext, useContext, type ReactNode } from 'react';

const CspNonceContext = createContext<string | undefined>(undefined);

export function CspNonceProvider({ nonce, children }: { nonce?: string; children: ReactNode }) {
  return <CspNonceContext.Provider value={nonce}>{children}</CspNonceContext.Provider>;
}

export function useCspNonce() {
  return useContext(CspNonceContext);
}
