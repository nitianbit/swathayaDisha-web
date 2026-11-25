import { ApiError } from './client.ts';
import { t } from './i18n/index.ts';

/**
 * One sentence a person can act on, for both apps (docs/I18N_PLAN.md §6). An area's own refusal words come first, in
 * the helpers that know the context (`assistedRefusal`, `labRefusal`, …); then the shared words for the error's code
 * (`errors.<CODE>` in the core catalogue); then the server's own message, written for people (English, the last
 * fallback); then "Something went wrong".
 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const key = `errors.${err.code ?? ''}`;
    if (err.code && t.has(key)) return t(key);
    if (err.status === 403) return err.message || t('errors.forbidden');
    return err.message;
  }
  return t('errors.unknown');
}
