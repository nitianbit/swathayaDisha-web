import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

export const t = catalogue('workspace-referral', en, import.meta.glob(['./*.json', '!./*.source.json']));
