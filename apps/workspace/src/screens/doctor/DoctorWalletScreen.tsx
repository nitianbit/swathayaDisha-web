import { useQuery } from '@tanstack/react-query';
import { DOCTOR_WALLET_CLOSED_MESSAGE, doctorWalletApi, doctorWalletRefusal, isDoctorWalletClosed, LAB_TOPUP_MAX_MINOR } from '@jansetu/api';
import { Alert } from '@jansetu/ui';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession, useStaff } from '../../session.tsx';
import { CursorPager, useCursorPages } from '../pharmacy/cursorList.tsx';
import { TopUpForm, type TopupSource } from '../pharmacy/topup.tsx';
import { WalletBalance, WalletHistory } from '../pharmacy/WalletScreen.tsx';

/**
 * WQ23: the doctor's own Jansetu wallet (assisted booking round 3a, backend r20, design §25.12), on the very pieces the
 * pharmacy and lab wallets show: the balance (with the card money that becomes withdrawable later), "Add money" by
 * Razorpay on a keyed order (`POST /specialists/me/assisted/wallet/topups`; after a lost answer the same key and amount,
 * WQ20b), the proof to `/payments/verify`, else the server's check; the doctor has no top-up list (r20 E7), so an
 * unconfirmed top-up is kept on this device by its record id only and checked from there. The history in cursor pages.
 * Only a verified, active doctor has a wallet: otherwise the page says so and shows nothing else.
 */
export function DoctorWalletScreen() {
  const doctor = useStaff();
  return (
    <>
      <PageHeading title="Wallet">Your Jansetu wallet. Add money by card or UPI; collect from your patient at your counter.</PageHeading>
      <Wallet key={doctor.id} doctorId={doctor.id} />
    </>
  );
}

function Wallet({ doctorId }: { doctorId: string }) {
  const { api } = useSession();
  const w = doctorWalletApi(api);
  const key = ['doctor-wallet', doctorId];
  const wallet = useQuery({ queryKey: [...key, 'balance'], queryFn: () => w.wallet() });
  const history = useCursorPages();
  const entries = useQuery({ queryKey: [...key, 'entries', history.cursor], queryFn: () => w.entries(history.cursor || undefined), enabled: wallet.isSuccess });
  if (wallet.isError && isDoctorWalletClosed(wallet.error)) return <Alert tone="warn">{DOCTOR_WALLET_CLOSED_MESSAGE}</Alert>;
  const source: TopupSource = {
    owner: `doctor-${doctorId}`, queryKey: key, maxRupees: LAB_TOPUP_MAX_MINOR / 100,
    start: (rupees, requestKey) => w.startTopup(Math.round(rupees * 100), requestKey),
    verify: (p) => w.verify(p), check: (id) => w.checkTopup(id), refusal: doctorWalletRefusal, rememberOnDevice: true, keyed: true,
  };
  return (
    <>
      <WalletBalance wallet={wallet} cardMoney />
      {wallet.isSuccess && (
        <>
          <section className="ws-section" aria-labelledby="top-h">
            <h2 id="top-h">Add money</h2>
            <TopUpForm pharmacyId={source.owner} source={source} />
          </section>
          <WalletHistory q={entries} empty="Top-ups and bookings paid from the wallet are listed here." first={history.page === 1}
            pager={<CursorPager pages={history} nextCursor={entries.data?.nextCursor} label="Wallet history pages" />} />
        </>
      )}
    </>
  );
}
