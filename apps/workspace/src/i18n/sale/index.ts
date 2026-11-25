import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** WQ50: the pharmacy's counter sale (Pharmacy › New sale). */
export const t = catalogue('workspace-sale', en, import.meta.glob(['./*.json', '!./*.source.json']));
