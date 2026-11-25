import { catalogue } from '@jansetu/i18n';
import en from './en.ts';

export const t = catalogue('workspace-shell', en, import.meta.glob(['./*.json', '!./*.source.json']));

/** A key of the shell catalogue (the side navigation's page names). */
export type ShellKey = Parameters<typeof t>[0];
