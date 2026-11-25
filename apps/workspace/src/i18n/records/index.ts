import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

/** WQ28: the doctor's patient-records words (records access, phase 3f). Its own catalogue while the doctor area is extracted. */
export const t = catalogue('workspace-records', en, import.meta.glob(['./*.json', '!./*.source.json']));
