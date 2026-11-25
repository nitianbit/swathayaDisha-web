import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { PharmacyFinance, ReferralBlock, WithdrawalsBlock } from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { formatDateTime } from '@jansetu/ui';
import { t } from '../../i18n/finance/index.ts';

/**
 * WQ48 (r35 §26.10): the money tiles of the Finance pages, from the server's blocks: the pharmacy's wallet and card money,
 * and everyone's referral earnings and withdrawals (a lab's and a doctor's Finance too; a block that is null is not shown).
 * Read only: each page's one action is elsewhere on it.
 */
export function FinanceTiles({ children }: { children: ReactNode }) {
  return <dl className="fin-cards" aria-label={t('tiles.label')}>{children}</dl>;
}

function Tile({ title, value, main = false, children }: { title: string; value: ReactNode; main?: boolean; children?: ReactNode }) {
  return (
    <div className={main ? 'fin-card fin-card--main' : 'fin-card'}>
      <dt>{title}</dt>
      <dd>{value}</dd>
      {children}
    </div>
  );
}
const Sub = ({ children }: { children: ReactNode }) => <dd className="fin-sub">{children}</dd>;
const sumLater = (w: PharmacyFinance['wallet']) => w.availableLater.reduce((a, l) => a + l.amountMinor, 0);

/** The pharmacy's wallet: its balance, what can be withdrawn now and later, what it owes, its hold. */
export function WalletTile({ wallet }: { wallet: PharmacyFinance['wallet'] }) {
  const later = sumLater(wallet);
  return (
    <Tile main title={t('tiles.wallet')} value={formatPaise(wallet.balanceMinor)}>
      <Sub>{t('tiles.now', { amount: formatPaise(wallet.withdrawableNowMinor) })}</Sub>
      {later > 0 && <Sub>{t('tiles.later', { amount: formatPaise(later) })}</Sub>}
      {wallet.receivableMinor > 0 && <Sub>{t('tiles.owed', { amount: formatPaise(wallet.receivableMinor) })}</Sub>}
      {wallet.frozen && <Sub>{t('tiles.onHold')}</Sub>}
    </Tile>
  );
}

/** Card money: the card top-ups not spent yet (withdrawable now and later). */
export function CardMoneyTile({ wallet }: { wallet: PharmacyFinance['wallet'] }) {
  return (
    <Tile title={t('tiles.card')} value={formatPaise(wallet.withdrawableNowMinor + sumLater(wallet))}>
      <Sub>{t('tiles.cardText')}</Sub>
    </Tile>
  );
}

/** What the referral cuts earned, were paid (r35b: and set off against an owed wallet amount) and are due. */
export function ReferralTile({ referral, link }: { referral: ReferralBlock; link?: string }) {
  return (
    <Tile title={t('tiles.referral')} value={formatPaise(referral.earnedMinor)}>
      <Sub>{t('tiles.referralPaid', { amount: formatPaise(referral.paidMinor) })}</Sub>
      {(referral.setOffMinor ?? 0) > 0 && <Sub>{t('tiles.referralSetOff', { amount: formatPaise(referral.setOffMinor!) })}</Sub>}
      <Sub>{t('tiles.referralDue', { amount: formatPaise(referral.dueMinor) })}</Sub>
      {!referral.payoutsEnabled && <Sub>{t('tiles.referralPaused')}</Sub>}
      {link && <Sub><Link to={link}>{t('tiles.referralLink')}</Link></Sub>}
    </Tile>
  );
}

/** Withdrawals waiting for Jansetu, and the last one paid. */
export function WithdrawalsTile({ withdrawals }: { withdrawals: WithdrawalsBlock }) {
  if (!withdrawals.enabled && withdrawals.openCount === 0) return <Tile title={t('tiles.withdrawals')} value={t('tiles.withdrawalsOff')} />;
  return (
    <Tile title={t('tiles.withdrawals')} value={t('tiles.waiting', { count: withdrawals.openCount })}>
      <Sub>{withdrawals.lastPaidAt ? t('tiles.lastPaid', { date: formatDateTime(withdrawals.lastPaidAt) }) : t('tiles.nonePaid')}</Sub>
    </Tile>
  );
}

/** A lab's or a doctor's two tiles from its finance read (each only when the server sends the block). */
export function OwnerFinanceTiles({ referral, withdrawals, referralLink }: {
  referral?: ReferralBlock | null; withdrawals?: WithdrawalsBlock | null; referralLink?: string;
}) {
  if (!referral && !withdrawals) return null;
  return (
    <FinanceTiles>
      {referral && <ReferralTile referral={referral} link={referralLink} />}
      {withdrawals && <WithdrawalsTile withdrawals={withdrawals} />}
    </FinanceTiles>
  );
}
