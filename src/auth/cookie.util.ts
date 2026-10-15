import { randomBytes } from 'crypto';
import type { Response } from 'express';
import type { AppConfig } from '../config/configuration';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface CookieConfig {
  cookieName: string;
  refreshCookieName: string;
  csrfCookieName: string;
  cookieSecure: boolean;
}

export function getCookieConfig(config: AppConfig['auth']): CookieConfig {
  return {
    cookieName: config.cookieName,
    refreshCookieName: config.refreshCookieName,
    csrfCookieName: config.csrfCookieName,
    cookieSecure: config.cookieSecure,
  };
}

export function deliverTokens(
  tokens: TokenPair,
  response: Response,
  cookieConfig: CookieConfig,
): void {
  const common = {
    httpOnly: true,
    secure: cookieConfig.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };
  response.cookie(cookieConfig.cookieName, tokens.accessToken, common);
  response.cookie(cookieConfig.refreshCookieName, tokens.refreshToken, common);
  response.cookie(
    cookieConfig.csrfCookieName,
    randomBytes(32).toString('base64url'),
    { secure: cookieConfig.cookieSecure, sameSite: 'lax', path: '/' },
  );
}

export function clearAuthCookies(
  response: Response,
  cookieConfig: CookieConfig,
): void {
  response.clearCookie(cookieConfig.cookieName, { path: '/' });
  response.clearCookie(cookieConfig.refreshCookieName, { path: '/' });
  response.clearCookie(cookieConfig.csrfCookieName, { path: '/' });
}
