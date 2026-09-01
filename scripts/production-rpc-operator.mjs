import { readServiceCredential } from './storage-operator-tools.mjs';
import {
  ProductionOperatorError,
  productionSupabaseUrl,
  readBoundedJsonResponse,
  readOperatorEnvironmentFile,
} from './production-operator-safety.mjs';

const RPC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

function fail(code) {
  throw new ProductionOperatorError(code);
}

export async function readProductionServiceCredential(environmentFile, additionalNames = []) {
  const names = ['SUPABASE_SECRET_KEY', ...additionalNames];
  const environment = await readOperatorEnvironmentFile(environmentFile, names);
  const serviceKey = readServiceCredential(
    { serviceRoleKeyEnv: 'SUPABASE_SECRET_KEY' },
    environment,
  );
  return { environment, serviceKey };
}

export async function callProductionServiceRpc({
  projectRef,
  rpcName,
  parameters,
  serviceKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  if (!RPC_NAME_PATTERN.test(rpcName ?? '')) fail('OPERATOR_RPC_NAME_INVALID');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    fail('OPERATOR_RPC_PARAMETERS_INVALID');
  }
  if (typeof serviceKey !== 'string' || serviceKey.length < 32)
    fail('OPERATOR_SERVICE_KEY_INVALID');
  if (typeof fetchImpl !== 'function') fail('OPERATOR_FETCH_UNAVAILABLE');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    fail('OPERATOR_TIMEOUT_INVALID');
  }

  const url = `${productionSupabaseUrl(projectRef)}/rest/v1/rpc/${rpcName}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail('OPERATOR_RPC_NETWORK_FAILED');
  }
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    throw new ProductionOperatorError(`OPERATOR_RPC_HTTP_${status}`);
  }
  return readBoundedJsonResponse(response);
}
