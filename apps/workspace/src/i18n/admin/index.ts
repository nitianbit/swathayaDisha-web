import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** The admin screens' words (`screens/admin/**`, docs/I18N_PLAN.md round 6j). */
export const t = catalogue('workspace-admin', en, import.meta.glob(['./*.json', '!./*.source.json']));
