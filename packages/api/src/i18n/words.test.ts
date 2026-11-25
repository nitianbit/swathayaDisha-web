import { setLanguage } from '@jansetu/i18n';
import { ApiError } from '../client.ts';
import { messageOf } from '../messages.ts';
import { ASSISTED_MODE_LABEL, PATIENT_LANGUAGES, SWITCHED_OFF_MESSAGE } from '../assisted.ts';
import { WEEKDAYS } from '../partners.ts';

describe('module-level words (docs/I18N_PLAN.md §3.4 rule 1)', () => {
  it('maps, lists and string constants keep their English and follow a language switch', async () => {
    const english = { mode: ASSISTED_MODE_LABEL.video, lang: PATIENT_LANGUAGES[0]!.label, day: WEEKDAYS[0]!.label, off: SWITCHED_OFF_MESSAGE };
    expect(english).toEqual({ mode: 'Video call', lang: 'Hindi', day: expect.any(String), off: expect.stringMatching(/\w/) });
    expect(Object.hasOwn(ASSISTED_MODE_LABEL, 'video')).toBe(true);
    expect(Object.keys(ASSISTED_MODE_LABEL)).toEqual(['video', 'call', 'in-person']);
    await setLanguage('pseudo');
    expect(ASSISTED_MODE_LABEL.video).not.toBe(english.mode);
    expect(PATIENT_LANGUAGES[0]!.label).not.toBe(english.lang);
    expect(WEEKDAYS[0]!.label).not.toBe(english.day);
    expect(SWITCHED_OFF_MESSAGE).not.toBe(english.off);
    await setLanguage('en');
    expect({ mode: ASSISTED_MODE_LABEL.video, lang: PATIENT_LANGUAGES[0]!.label, day: WEEKDAYS[0]!.label, off: SWITCHED_OFF_MESSAGE }).toEqual(english);
  });
});

describe('messageOf (docs/I18N_PLAN.md §6)', () => {
  it('words for a known code first, then the server message, then the fallbacks', async () => {
    expect(messageOf(new ApiError(0, 'whatever', 'NETWORK'))).toBe('Could not reach the server. Check your connection and try again.');
    expect(messageOf(new ApiError(409, 'Server words.', 'SOMETHING_NEW'))).toBe('Server words.');
    expect(messageOf(new ApiError(403, ''))).toBe('Your account is not allowed to do this.');
    expect(messageOf(new Error('internal'))).toBe('Something went wrong. Please try again.');
    await setLanguage('pseudo');
    expect(messageOf(new ApiError(0, 'whatever', 'TIMEOUT'))).not.toMatch(/^The server took too long/);
    expect(messageOf(new ApiError(409, 'Server words.', 'SOMETHING_NEW'))).toBe('Server words.');
  });
});
