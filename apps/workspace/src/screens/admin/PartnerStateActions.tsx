import { useQueryClient } from '@tanstack/react-query';
import { partnerAdminApi, type Partner } from '@jansetu/api';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
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
        <ConfirmAction label="Verify" confirmLabel={`Verify ${partner.name}`}
          consequence={`${partner.name} is marked verified: its members can start using the workspace and it can take bookings.`}
          onConfirm={() => act(() => admin.verify(partner._id))} />
      )}
      {state !== 'suspended' && (
        <ConfirmAction label="Suspend" danger confirmLabel={`Suspend ${partner.name}`}
          consequence={`${partner.name} is suspended and deactivated: its members are signed out and cannot sign in until it is reinstated.`}
          onConfirm={() => act(() => admin.suspend(partner._id))} />
      )}
      {state === 'suspended' && (
        <ConfirmAction label="Reinstate" confirmLabel={`Reinstate ${partner.name}`}
          consequence={`${partner.name} becomes verified and active again: its members can sign in and it can take bookings.`}
          onConfirm={() => act(() => admin.reinstate(partner._id))} />
      )}
    </div>
  );
}
