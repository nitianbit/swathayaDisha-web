import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** WQ54 (P1): the simple pharmacy home: its big buttons, + New, Today and to-dos. */
export const t = catalogue('workspace-home', en, import.meta.glob(['./*.json', '!./*.source.json']));
