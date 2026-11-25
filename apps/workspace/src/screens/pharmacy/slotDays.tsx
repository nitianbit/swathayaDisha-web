import { formatSlotDate } from '@jansetu/api';
import { Button } from '@jansetu/ui';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ17: free times grouped by day, one button each (WQ12, moved here from Book consultation so that Book lab test picks a
 * time the very same way). `day` is YYYYMMDD or YYYY-MM-DD.
 */
export function SlotDays<S extends { slotId: string; startTime: string; endTime?: string }>({ days, chosen, onChoose }: {
  days: readonly (readonly [string, readonly S[]])[]; chosen: string | null; onChoose: (s: S) => void;
}) {
  return (
    <>
      {days.map(([day, times]) => {
        const shown = formatSlotDate(day.replace(/-/g, ''));
        return (
          <fieldset key={day} className="ws-checks">
            <legend>{t('common.freeTimesOnFull2', { shown })}</legend>
            <div className="ws-actions">
              {times.map((s) => (
                <Button key={s.slotId} variant={chosen === s.slotId ? 'primary' : 'secondary'} aria-pressed={chosen === s.slotId}
                  aria-label={`${shown} ${s.startTime}${s.endTime ? `–${s.endTime}` : ''}`} onClick={() => onChoose(s)}>
                  {s.startTime}{s.endTime ? `–${s.endTime}` : ''}
                </Button>
              ))}
            </div>
          </fieldset>
        );
      })}
    </>
  );
}
