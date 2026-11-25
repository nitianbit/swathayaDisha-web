import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

export const t = catalogue('api-doctor', en, import.meta.glob(['./*.json', '!./*.source.json']));
