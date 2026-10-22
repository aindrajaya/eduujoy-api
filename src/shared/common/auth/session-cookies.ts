import { type CookieOptions, type Response } from 'express';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service';

export const ACCESS_COOKIE = 'ej_at';
export const REFRESH_COOKIE = 'ej_rt';
export const REFRESH_COOKIE_PATH = '/v1/auth';
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

// Same flags in every environment (Secure is honoured on http://localhost by browsers).
// Host-only: no Domain attribute, so the cookies stay on the API host (PRD-API §6).
const BASE: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' };

export const accessCookieOptions: CookieOptions = { ...BASE, path: '/', maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000 };
export const refreshCookieOptions: CookieOptions = {
  ...BASE,
  path: REFRESH_COOKIE_PATH,
  maxAge: REFRESH_TTL_SECONDS * 1000,
};

/** Signs the browser out: clears both cookies (logout, Google sign-in errors, account deletion). */
export function clearSessionCookies(res: Response): void {
  // clearCookie must repeat path and flags (but not maxAge) for the browser to match the cookie.
  res.clearCookie(ACCESS_COOKIE, { ...accessCookieOptions, maxAge: undefined });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions, maxAge: undefined });
}
