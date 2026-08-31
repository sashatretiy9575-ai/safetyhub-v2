import assert from 'node:assert/strict';
import test from 'node:test';
import { isSameOriginRequest } from '../../features/auth/request-origin.ts';

function request(url, origin) {
  return new Request(url, { method: 'POST', headers: origin ? { Origin: origin } : {} });
}

test('same-origin writes require both Origin and request URL to match the canonical site', () => {
  const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const previousVercelEnvironment = process.env.VERCEL_ENV;
  process.env.NEXT_PUBLIC_SITE_URL = 'https://safetyhub.kz';
  process.env.VERCEL_ENV = 'production';
  try {
    assert.equal(
      isSameOriginRequest(request('https://safetyhub.kz/api/profile', 'https://safetyhub.kz')),
      true,
    );
    assert.equal(
      isSameOriginRequest(request('https://attacker.example/api/profile', 'https://attacker.example')),
      false,
    );
    assert.equal(
      isSameOriginRequest(request('https://safetyhub.kz/api/profile', 'https://attacker.example')),
      false,
    );
    assert.equal(isSameOriginRequest(request('https://safetyhub.kz/api/profile', null)), false);
  } finally {
    if (previousSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
    if (previousVercelEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnvironment;
  }
});
