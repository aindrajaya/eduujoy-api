import { type Env } from './env';

/** Typed, validated configuration. Inject this instead of reading process.env. */
export class AppConfig {
  constructor(readonly env: Readonly<Env>) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
