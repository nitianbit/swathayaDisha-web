import { useQueryClient } from '@tanstack/react-query';
import { partnerAdminApi, type Partner } from '@jansetu/api';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { t } from '../../i18n/admin/index.ts';
import { useSession } from '../../session.tsx';

/** Admin: verify a pending partner (opens its workspace), suspend it (signs its members out) or reinstate a suspended one. */
export function PartnerStateActions({ partner }: { partner: Partner }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const admin = partnerAdminApi(api);
  const state = partner.verification?.state;
  /** The server's record decides; re-read after every answer, also a refusal (e.g. 409 already suspended). */
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-partners'] }),
        queryClient.invalidateQueries({ queryKey: ['partner-ws', partner._id] }),
      ]);
    }
  };
  return (
    <div className="ws-actions">
      {state === 'pending' && (
        <ConfirmAction label={t('partnerActions.verify')} confirmLabel={t('partnerActions.verifyConfirm', { name: partner.name })}
          consequence={t('partnerActions.verifyConsequence', { name: partner.name })}
          onConfirm={() => act(() => admin.verify(partner._id))} />
      )}
      {state !== 'suspended' && (
        <ConfirmAction label={t('partnerActions.suspend')} danger confirmLabel={t('partnerActions.suspendConfirm', { name: partner.name })}
          consequence={t('partnerActions.suspendConsequence', { name: partner.name })}
          onConfirm={() => act(() => admin.suspend(partner._id))} />
      )}
      {state === 'suspended' && (
        <ConfirmAction label={t('partnerActions.reinstate')} confirmLabel={t('partnerActions.reinstateConfirm', { name: partner.name })}
          consequence={t('partnerActions.reinstateConsequence', { name: partner.name })}
          onConfirm={() => act(() => admin.reinstate(partner._id))} />
      )}
    </div>
  );
}
