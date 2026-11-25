import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

export const t = catalogue('api-lab', en, import.meta.glob(['./*.json', '!./*.source.json']));
