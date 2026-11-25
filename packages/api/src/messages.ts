import { ApiError } from './client.ts';
import { t } from './i18n/index.ts';

/** "Use at most {max} characters." under a field: the same words on every form. */
export const tooLongWords = (max: number): string => t('field.tooLong', { max });
/** "Could not reach the server. Check your connection and try again.": one sentence for every app. */
export const networkWords = (): string => t('errors.NETWORK');

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
