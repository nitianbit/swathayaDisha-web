import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** The customer app's words (docs/I18N_PLAN.md §3.2): English in `en.ts`, checked translations in `<lang>.json`. */
export const t = catalogue('customer', en, import.meta.glob(['./*.json', '!./*.source.json']));
export type CustomerKey = keyof typeof en;
