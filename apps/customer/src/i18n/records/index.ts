import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** WQ28: the account holder's records-access words (phase 3f). Its own catalogue while the customer app is extracted. */
export const t = catalogue('customer-records', en, import.meta.glob(['./*.json', '!./*.source.json']));
