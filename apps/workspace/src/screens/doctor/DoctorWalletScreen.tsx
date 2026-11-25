import { useQuery } from '@tanstack/react-query';
import { DOCTOR_WALLET_CLOSED_MESSAGE, doctorWalletApi, isDoctorWalletClosed } from '@jansetu/api';
import { Alert } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { CursorPager, useCursorPages } from '../pharmacy/cursorList.tsx';
import { DeviceTopups, ownerTopupSource, TopUpForm } from '../pharmacy/topup.tsx';
import { usePayerWallet, WalletBalance, WalletHistory } from '../pharmacy/WalletScreen.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * WQ23: the doctor's own Jansetu wallet (assisted booking round 3a, backend r20, design §25.12), on the very pieces the
 * pharmacy and lab wallets show: the balance (with the card money that becomes withdrawable later), "Add money" by
 * Razorpay on a keyed order (`POST /specialists/me/assisted/wallet/topups`; after a lost answer the same key and amount,
 * WQ20b), the proof to `/payments/verify`, else the server's check; the doctor has no top-up list (r20 E7), so an
 * unconfirmed top-up is kept on this device by its record id only and checked from there. The history in cursor pages.
 * Only a verified, active doctor has a wallet: otherwise the page says so and shows only the top-ups this device still has
 * to check (the check answers an ineligible doctor too, r20 E8).
 */
export function DoctorWalletScreen() {
  const doctor = useStaff();
  return (
    <>
      <PageHeading title={t('doctorWallet.wallet')}>{t('doctorWallet.yourJansetuWalletAddMoney')}</PageHeading>
      <Wallet key={doctor.id} doctorId={doctor.id} />
    </>
  );
}

function Wallet({ doctorId }: { doctorId: string }) {
  const { api } = useSession();
  const w = doctorWalletApi(api);
  const key = ['doctor-wallet', doctorId];
  const wallet = usePayerWallet({ kind: 'doctor', id: doctorId });
  const history = useCursorPages();
  const entries = useQuery({ queryKey: [...key, 'entries', history.cursor], queryFn: () => w.entries(history.cursor || undefined), enabled: !!wallet.data });
  const source = ownerTopupSource(w, 'doctor', doctorId, key);
  const closed = wallet.isError && isDoctorWalletClosed(wallet.error);
  return (
    <>
      {closed ? <Alert tone="warn">{DOCTOR_WALLET_CLOSED_MESSAGE}</Alert> : <WalletBalance wallet={wallet} cardMoney />}
      {/* Once read, a failed read again keeps these; only the server's "closed" hides them. */}
      {wallet.data && !closed ? (
        <>
          <section className="ws-section" aria-labelledby="top-h">
            <h2 id="top-h">{t('doctorWallet.addMoney')}</h2>
            <TopUpForm pharmacyId={source.owner} source={source} />
          </section>
          <WalletHistory q={entries} empty={t('doctorWallet.topUpsAndBookingsPaid')} first={history.page === 1}
            pager={<CursorPager pages={history} nextCursor={entries.data?.nextCursor} label={t('doctorWallet.walletHistoryPages')} />} />
        </>
      ) : (
        // This device's unconfirmed top-ups, kept in place while the wallet is read again (so a check's answer stays).
        <DeviceTopups source={source} />
      )}
    </>
  );
}
