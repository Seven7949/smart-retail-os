/**
 * Amazon Cognito sign-up / sign-in over its public JSON API (no SDK needed).
 * Tokens live in expo-secure-store (Android Keystore), never AsyncStorage.
 */
import * as SecureStore from 'expo-secure-store';
import { b64ToBytes } from '../domain/ledger';
import type { CloudConfig } from './config';

const TOKENS_KEY = 'sros.tokens.v1';
const REFRESH_MARGIN_MS = 60_000;

export interface Tokens {
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly sub: string;
  readonly email: string;
}

export class AuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  UsernameExistsException: 'An account with this email already exists. Sign in instead.',
  NotAuthorizedException: 'Wrong email or password.',
  UserNotConfirmedException: 'Please enter the verification code sent to your email.',
  CodeMismatchException: 'That code is not correct.',
  ExpiredCodeException: 'That code has expired. Request a new one.',
  InvalidPasswordException: 'Password needs at least 8 characters with a number and a lowercase letter.',
  LimitExceededException: 'Too many attempts. Please wait a few minutes.',
  UserNotFoundException: 'Wrong email or password.',
};

export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new AuthError('BadToken', 'malformed token');
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(b64ToBytes(b64)));
}

async function cognito<T>(cfg: CloudConfig, target: string, body: object, fetchFn: typeof fetch): Promise<T> {
  const res = await fetchFn(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(json.__type ?? 'Error').split('#').pop()!;
    throw new AuthError(code, FRIENDLY[code] ?? 'Could not reach the account service. Try again.');
  }
  return json as T;
}

interface AuthResult { AuthenticationResult: { IdToken: string; RefreshToken?: string; ExpiresIn: number } }

function toTokens(r: AuthResult, refreshToken?: string): Tokens {
  const a = r.AuthenticationResult;
  const claims = decodeJwt(a.IdToken);
  return {
    idToken: a.IdToken, refreshToken: a.RefreshToken ?? refreshToken ?? '', expiresAt: Date.now() + a.ExpiresIn * 1000,
    sub: String(claims.sub), email: String(claims.email ?? ''),
  };
}

export class Auth {
  constructor(private readonly cfg: CloudConfig, private readonly fetchFn: typeof fetch = fetch) {}

  async signUp(email: string, password: string): Promise<void> {
    await cognito(this.cfg, 'SignUp', {
      ClientId: this.cfg.clientId, Username: email.trim().toLowerCase(), Password: password,
      UserAttributes: [{ Name: 'email', Value: email.trim().toLowerCase() }],
    }, this.fetchFn);
  }

  async confirm(email: string, code: string): Promise<void> {
    await cognito(this.cfg, 'ConfirmSignUp', { ClientId: this.cfg.clientId, Username: email.trim().toLowerCase(), ConfirmationCode: code.trim() }, this.fetchFn);
  }

  async signIn(email: string, password: string): Promise<Tokens> {
    const r = await cognito<AuthResult>(this.cfg, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH', ClientId: this.cfg.clientId,
      AuthParameters: { USERNAME: email.trim().toLowerCase(), PASSWORD: password },
    }, this.fetchFn);
    const tokens = toTokens(r);
    await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens));
    return tokens;
  }

  async current(): Promise<Tokens | null> {
    const raw = await SecureStore.getItemAsync(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  }

  /** A valid ID token, refreshed when it is about to expire. */
  async idToken(): Promise<string | null> {
    const t = await this.current();
    if (!t) return null;
    if (t.expiresAt - REFRESH_MARGIN_MS > Date.now()) return t.idToken;
    try {
      const r = await cognito<AuthResult>(this.cfg, 'InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: this.cfg.clientId, AuthParameters: { REFRESH_TOKEN: t.refreshToken },
      }, this.fetchFn);
      const fresh = toTokens(r, t.refreshToken);
      await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(fresh));
      return fresh.idToken;
    } catch (e) {
      if (e instanceof AuthError && e.code === 'NotAuthorizedException') await this.signOut();
      throw e;
    }
  }

  async signOut(): Promise<void> {
    await SecureStore.deleteItemAsync(TOKENS_KEY);
  }
}
