import { ApiError, CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE } from '@jansetu/api';
import { messageOf } from './errors.ts';

describe('messageOf', () => {
  it('WQ15: the clinic refusal for a doctor not verified or not active has its own plain words (not the server’s)', () => {
    expect(messageOf(new ApiError(403, 'this clinic workspace is closed to you; contact Jansetu support', 'CLINIC_OWNER_DOCTOR_NOT_VERIFIED')))
      .toBe(CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE);
    expect(messageOf(new ApiError(403, 'closed', 'CLINIC_DOCTOR_NOT_VERIFIED'))).toBe(CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE);
    expect(messageOf(new ApiError(403, 'Not yours', 'FORBIDDEN'))).toBe('Not yours');
  });
});
