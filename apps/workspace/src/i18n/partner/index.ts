import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** Lab, clinic and partner-team screens of the workspace (`screens/partner`). */
export const t = catalogue('workspace-partner', en, import.meta.glob(['./*.json', '!./*.source.json']));
/** Any key of this catalogue (for maps of codes to words). */
export type PartnerKey = keyof typeof en & string;
