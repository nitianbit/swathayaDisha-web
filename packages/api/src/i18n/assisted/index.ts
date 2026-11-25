import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

export const t = catalogue('api-assisted', en, import.meta.glob(['./*.json', '!./*.source.json']));
/** A key of this catalogue (for maps from a server code to its words). */
export type AssistedKey = Parameters<typeof t>[0];
