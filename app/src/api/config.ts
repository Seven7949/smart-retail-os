/** Cloud configuration. Values are public identifiers (no secrets): they are
 * baked in at build time from the CDK outputs and can be overridden in
 * Settings. Authorisation is enforced server-side by Cognito + IAM. */
export interface CloudConfig {
  readonly apiUrl: string;
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const POOL_RE = /^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/;
const CLIENT_RE = /^[a-z0-9]{20,40}$/;

export function buildTimeConfig(): Partial<CloudConfig> {
  return {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? '',
    region: process.env.EXPO_PUBLIC_AWS_REGION ?? 'ap-south-1',
    userPoolId: process.env.EXPO_PUBLIC_USER_POOL_ID ?? '',
    clientId: process.env.EXPO_PUBLIC_USER_POOL_CLIENT_ID ?? '',
  };
}

export function validateConfig(c: Partial<CloudConfig>): { ok: true; config: CloudConfig } | { ok: false; error: string } {
  const apiUrl = (c.apiUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/.test(apiUrl)) return { ok: false, error: 'API URL must start with https://' };
  if (!REGION_RE.test(c.region ?? '')) return { ok: false, error: 'Invalid AWS region' };
  if (!POOL_RE.test(c.userPoolId ?? '')) return { ok: false, error: 'Invalid user pool id' };
  if (!CLIENT_RE.test(c.clientId ?? '')) return { ok: false, error: 'Invalid app client id' };
  return { ok: true, config: { apiUrl, region: c.region!, userPoolId: c.userPoolId!, clientId: c.clientId! } };
}
