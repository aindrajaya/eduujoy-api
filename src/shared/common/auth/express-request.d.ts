import { type AccessClaims } from './access-token.service';

declare global {
  namespace Express {
    interface Request {
      /** Set by JwtAuthGuard from a verified `ej_at` cookie. */
      user?: AccessClaims;
    }
  }
}
