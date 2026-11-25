import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cleanRecommendationCode, matchRecommended, recommendationRefusal, recommendationsOff, type TestRecommendation } from '@jansetu/api';
import { Button, TextField } from '@jansetu/ui';
import type { Perform } from '../finance/finance.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ21 (r16 phase 3d, §25.12.4): "Have a test code from the doctor?": the recommended test names, loaded by the code on the
 * prescription and the patient's number with `POST …/recommendations/lookup {code, phone}` (r16b: both in the body, never
 * in a URL; `load`: the pharmacy's route, or the lab desk's, WQ21b). The tests of the chosen
 * catalogue named exactly so are ticked once per catalogue and code; the booker can change the ticks. The code and the number
 * stay in the page's state. Bookings are not linked to the recommendation yet (later): nothing new is sent on create.
 */
export function useRecommendedTicks(items: readonly { itemId: string; name: string }[] | null, catalogueKey: string | null, setItemIds: (ids: string[]) => void) {
  const [rec, setRec] = useState<TestRecommendation | null>(null);
  const [off, setOff] = useState(false);
  const applied = useRef('');
  useEffect(() => {
    if (!rec || !items || !catalogueKey) return;
    const key = `${catalogueKey}:${rec.code}`;
    if (applied.current === key) return;
    applied.current = key;
    setItemIds(matchRecommended(items, rec.items.map((i) => i.name)).itemIds);
  }, [rec, items, catalogueKey]);
  const unmatched = rec && items && catalogueKey ? matchRecommended(items, rec.items.map((i) => i.name)).unmatched : null;
  return {
    rec, off, unmatched,
    loaded: (r: TestRecommendation) => { applied.current = ''; setRec(r); },
    switchedOff: () => { setOff(true); setRec(null); },
    reset: () => { setRec(null); applied.current = ''; },
  };
}

export function RecommendedTests({ load, phone, perform, disabled, ticks, label = t('recommendedTests.haveATestCodeFrom') }: {
  load: (code: string, phone: string) => Promise<TestRecommendation>; phone: string; perform: Perform; disabled: boolean;
  ticks: ReturnType<typeof useRecommendedTicks>;
  /** WQ25: the field's words (a doctor's own booking: no "from the doctor"). */
  label?: string;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (ticks.off) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const code = cleanRecommendationCode(text);
    if (!code) { setError(t('recommendedTests.thisCodeIsNotValid')); return; }
    setError(null);
    setLoading(true);
    try {
      ticks.loaded(await perform(() => load(code, phone)));
    } catch (err) {
      if (recommendationsOff(err)) { ticks.switchedOff(); return; }
      setError(recommendationRefusal(err));
    } finally {
      setLoading(false);
    }
  }
  const { rec, unmatched } = ticks;
  return (
    <form className="ws-search" noValidate onSubmit={(e) => void submit(e)} aria-label={t('recommendedTests.recommendedTests')}>
      <TextField label={label} autoComplete="off" value={text} error={error} disabled={disabled} maxLength={20}
        hint={rec ? t('recommendedTests.recommendedTests2', { value: rec.items.map((i) => i.name).join(', ') }) : t('recommendedTests.itIsOnThePrescription')}
        onChange={(e) => setText(e.target.value)} />
      <Button type="submit" variant="secondary" busy={loading} disabled={disabled}>{t('recommendedTests.loadTests')}</Button>
      {unmatched && unmatched.length > 0 && <span className="ws-muted">{unmatched.map((n) => `${n}: not in this lab's list`).join('. ')}.</span>}
    </form>
  );
}
