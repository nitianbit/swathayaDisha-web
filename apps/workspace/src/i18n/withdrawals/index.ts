import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** WQ29: wallet withdrawals to the bank (owners and admins) and the admin's Recover. Its own catalogue while the wallet areas are extracted. */
export const t = catalogue('workspace-withdrawals', en, import.meta.glob(['./*.json', '!./*.source.json']));
