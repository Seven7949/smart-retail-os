import * as SecureStore from 'expo-secure-store';
import { Auth, AuthError, decodeJwt } from '../auth';
import { ApiClient, ApiError, toCloudCustomer } from '../client';
import { validateConfig } from '../config';

const CFG = { apiUrl: 'https://abc.execute-api.ap-south-1.amazonaws.com', region: 'ap-south-1', userPoolId: 'ap-south-1_AbCdEf123', clientId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3' };
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const res = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json });

describe('config', () => {
  test('accepts real CDK outputs, rejects bad values', () => {
    expect(validateConfig({ ...CFG, apiUrl: CFG.apiUrl + '/' })).toEqual({ ok: true, config: CFG });
    expect(validateConfig({ ...CFG, apiUrl: 'http://insecure.com' })).toMatchObject({ ok: false });
    expect(validateConfig({ ...CFG, region: 'mars' })).toMatchObject({ ok: false });
    expect(validateConfig({ ...CFG, userPoolId: 'x' })).toMatchObject({ ok: false });
    expect(validateConfig({ ...CFG, clientId: 'UPPER' })).toMatchObject({ ok: false });
  });
});

describe('auth', () => {
  beforeEach(async () => { await SecureStore.deleteItemAsync('sros.tokens.v1'); });

  test('decodeJwt handles base64url and rejects junk', () => {
    expect(decodeJwt(jwt({ sub: 'é-ü' }))).toEqual({ sub: 'é-ü' });
    expect(() => decodeJwt('nope')).toThrow(AuthError);
  });

  test('sign in stores tokens securely; refresh near expiry; sign out on revoked refresh', async () => {
    let expires = 3600;
    const fetchFn = jest.fn(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.AuthFlow === 'REFRESH_TOKEN_AUTH' && body.AuthParameters.REFRESH_TOKEN === 'revoked') return res(400, { __type: 'x#NotAuthorizedException' });
      return res(200, { AuthenticationResult: { IdToken: jwt({ sub: 's1', email: 'a@b.co' }), RefreshToken: 'r1', ExpiresIn: expires } });
    }) as unknown as typeof fetch;
    const auth = new Auth(CFG, fetchFn);
    const t = await auth.signIn(' A@B.CO ', 'pw');
    expect(t.sub).toBe('s1');
    expect((fetchFn as jest.Mock).mock.calls[0][1].body).toContain('"USERNAME":"a@b.co"');
    expect(await auth.idToken()).toBe(t.idToken);

    expires = 10; // already near expiry -> refresh path
    await auth.signIn('a@b.co', 'pw');
    expect(await auth.idToken()).toBeTruthy();
    const refreshCall = (fetchFn as jest.Mock).mock.calls.at(-1)[1].body;
    expect(refreshCall).toContain('REFRESH_TOKEN_AUTH');

    await SecureStore.setItemAsync('sros.tokens.v1', JSON.stringify({ ...t, refreshToken: 'revoked', expiresAt: 0 }));
    await expect(auth.idToken()).rejects.toThrow(AuthError);
    expect(await auth.current()).toBeNull();
  });

  test('sign up + confirm map Cognito errors to friendly text', async () => {
    const fetchFn = jest.fn(async () => res(400, { __type: 'UsernameExistsException' })) as unknown as typeof fetch;
    const auth = new Auth(CFG, fetchFn);
    await expect(auth.signUp('a@b.co', 'pw')).rejects.toThrow(/already exists/);
    const ok = new Auth(CFG, jest.fn(async () => res(200, {})) as unknown as typeof fetch);
    await expect(ok.confirm('a@b.co', '123456')).resolves.toBeUndefined();
    const weird = new Auth(CFG, jest.fn(async () => res(500, 'not json')) as unknown as typeof fetch);
    await expect(weird.signUp('a@b.co', 'pw')).rejects.toThrow(/Could not reach/);
    expect(await ok.idToken()).toBeNull();
  });
});

describe('api client', () => {
  const auth = { idToken: async () => 'tok' } as unknown as Auth;

  test('maps API and network errors', async () => {
    const c1 = new ApiClient(CFG, auth, jest.fn(async () => res(409, { error: { code: 'CHAIN_FORK', message: 'fork' } })) as unknown as typeof fetch);
    await expect(c1.verifyLedger()).rejects.toMatchObject({ status: 409, code: 'CHAIN_FORK' });
    const c2 = new ApiClient(CFG, auth, jest.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
    await expect(c2.insights()).rejects.toMatchObject({ code: 'NETWORK' });
    const c3 = new ApiClient(CFG, auth, jest.fn(async () => res(200, [1])) as unknown as typeof fetch);
    await expect(c3.publicKey()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    const signedOut = new ApiClient(CFG, { idToken: async () => null } as unknown as Auth, jest.fn() as unknown as typeof fetch);
    await expect(signedOut.refreshInsights()).rejects.toBeInstanceOf(ApiError);
  });

  test('voice + scan requests', async () => {
    const calls: any[] = [];
    const fetchFn = jest.fn(async (url: string, init: any) => {
      calls.push([url, init]);
      if (url.endsWith('/scan/upload-url')) return res(200, { key: 'scans/s/k.jpg', url: 'https://bucket.s3.amazonaws.com/', fields: { key: 'scans/s/k.jpg', policy: 'p' } });
      if (url.startsWith('https://bucket')) return res(204, null);
      if (url.endsWith('/scan/parse')) return res(200, { vendor: 'V', invoiceDate: null, totalPaise: 100, lines: [] });
      return res(200, { lines: [{ sku: 'sugar-1', qtyMilli: 2000 }] });
    }) as unknown as typeof fetch;
    const api = new ApiClient(CFG, auth, fetchFn);
    const v = await api.voiceParse('do kilo cheeni', [{ sku: 'sugar-1', name: 'Sugar', unit: 'kg' }]);
    expect(v.lines[0].qtyMilli).toBe(2000);
    const scan = await api.scanInvoice('file:///x.jpg', 'image/jpeg');
    expect(scan.vendor).toBe('V');
    expect(calls[2][1].body).toBeInstanceOf(FormData);
    expect(JSON.parse(calls[3][1].body)).toEqual({ key: 'scans/s/k.jpg' });

    const badUrl = new ApiClient(CFG, auth, jest.fn(async () => res(200, { key: 'k', url: 'http://evil', fields: {} })) as unknown as typeof fetch);
    await expect(badUrl.scanInvoice('file:///x', 'image/png')).rejects.toMatchObject({ code: 'BAD_UPLOAD_URL' });
  });

  test('phone numbers never leave the phone', () => {
    expect(toCloudCustomer({ customerId: 'c', name: 'n', phone: '+91999' })).toEqual({ customerId: 'c', name: 'n' });
  });
});
