import { createApiClient } from './client.ts';
import { authApi, partnerSelectionOf } from './auth.ts';
import {
  ADMIN_ACTOR, ALL_PARTNER_PERMISSIONS, canAddOwner, canEditPermissions, grantablePermissions, holdsAny, partnerAdminApi,
  partnerWorkspaceApi, partnerWorkspaceBase, removalBlock, scopeProblem, type PartnerActorView,
} from './partners.ts';

const P = 'a1'.repeat(12);
const M = 'b2'.repeat(12);
const B = 'c3'.repeat(12);

function recorder() {
  const calls: { method: string; url: string; body: unknown; init: RequestInit }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined, init: init ?? {} });
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    } });
  return { client, calls };
}

describe('partner workspace paths', () => {
  it('members use /partner-workspace; admins the same routes under /partner-workspace/admin/:id/workspace', async () => {
    const { client, calls } = recorder();
    const member = partnerWorkspaceApi(client, { kind: 'member' });
    const admin = partnerWorkspaceApi(client, { kind: 'admin', partnerId: P });
    await member.members();
    await admin.members();
    await admin.setPermissions(M, ['bookings.view']);
    await member.removeMember(M);
    await admin.updateBranch(B, { name: 'Main' });
    await member.deactivateBranch(B);
    await admin.audit();
    await admin.updateMe({ name: 'City Lab' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/members',
      `GET /partner-workspace/admin/${P}/workspace/members`,
      `PUT /partner-workspace/admin/${P}/workspace/members/${M}/permissions`,
      `DELETE /partner-workspace/members/${M}`,
      `PUT /partner-workspace/admin/${P}/workspace/branches/${B}`,
      `DELETE /partner-workspace/branches/${B}`,
      `GET /partner-workspace/admin/${P}/workspace/audit`,
      `PUT /partner-workspace/admin/${P}/workspace/me`,
    ]);
    expect(calls[2]!.body).toEqual({ permissions: ['bookings.view'] });
  });

  it('refuses an id that is not an object id before any request', async () => {
    const { client, calls } = recorder();
    expect(() => partnerWorkspaceBase({ kind: 'admin', partnerId: '../x' })).toThrow('Invalid partner id');
    expect(() => partnerWorkspaceApi(client, { kind: 'admin', partnerId: `${P}/members` }).members()).toThrow('Invalid partner id');
    expect(() => partnerWorkspaceApi(client, { kind: 'member' }).member('abc')).toThrow('Invalid member id');
    expect(() => partnerWorkspaceApi(client, { kind: 'member' }).updateBranch('1'.repeat(25), {})).toThrow('Invalid branch id');
    expect(() => partnerAdminApi(client).verify('not-an-id')).toThrow('Invalid partner id');
    expect(calls).toHaveLength(0);
  });

  it('admin partner accounts: list filters as query, verify and suspend by id', async () => {
    const { client, calls } = recorder();
    const admin = partnerAdminApi(client);
    await admin.list({ kind: 'lab', verificationState: 'pending', isActive: undefined });
    await admin.verify(P);
    await admin.suspend(P);
    await admin.update(P, { taxRegime: 'regular' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/admin?kind=lab&verificationState=pending',
      `POST /partner-workspace/admin/${P}/verify`,
      `POST /partner-workspace/admin/${P}/suspend`,
      `PUT /partner-workspace/admin/${P}`,
    ]);
  });
});

describe('partner sign-in selection (Q7)', () => {
  it('recognises a selection answer and keeps only choices with a usable id', () => {
    expect(partnerSelectionOf({ token: 't', user: {} })).toBeNull();
    expect(partnerSelectionOf({ selectionRequired: true, choices: [] })).toBeNull();
    const s = partnerSelectionOf({ selectionRequired: true, ticket: 'tk', choices: [
      { partnerId: P, name: 'City Lab', kind: 'lab', solo: false, role: 'owner' },
      { partnerId: 'nope', name: 'Bad', kind: 'clinic', solo: false, role: 'staff' },
    ] });
    expect(s?.ticket).toBe('tk');
    expect(s?.choices.map((c) => c.name)).toEqual(['City Lab']);
  });

  it('select is sent in the same session mode as the verify', async () => {
    const { client, calls } = recorder();
    const auth = authApi(client);
    await auth.selectPartner('tk', P, { kind: 'bearer' });
    await auth.selectPartner('tk', P, { kind: 'cookie' });
    await auth.selectPartner('tk', P, { kind: 'native', app: 'workspace', previousRefreshToken: 'rt-old' });
    expect(calls.every((c) => c.url === '/auth/partner/select' && c.method === 'POST')).toBe(true);
    expect(calls.map((c) => c.body)).toEqual([
      { ticket: 'tk', partnerId: P },
      { ticket: 'tk', partnerId: P, session: 'cookie' },
      { ticket: 'tk', partnerId: P, session: 'native', app: 'workspace', previousRefreshToken: 'rt-old' },
    ]);
    const headers = calls.map((c) => c.init.headers as Record<string, string>);
    expect(headers[0]!.Authorization).toBeUndefined();
    expect(headers[1]!['X-Jansetu-Session']).toBe('1');
    expect(calls[1]!.init.credentials).toBe('same-origin');
    expect(headers[2]!['X-Jansetu-Native']).toBe('1');
    expect(calls[2]!.init.credentials).toBe('omit');
    expect(() => auth.selectPartner('tk', 'x', { kind: 'bearer' })).toThrow('Invalid partner id');
  });
});

describe('partner rules mirrored from the backend service', () => {
  const owner: PartnerActorView = { role: 'owner', permissions: [], branchIds: [], memberId: M };
  const staff: PartnerActorView = { role: 'staff', permissions: ['staff.manage', 'bookings.view'], branchIds: [B], memberId: 'd4'.repeat(12) };
  const wideStaff: PartnerActorView = { ...staff, branchIds: [] };

  it('delegation ceiling: owners grant everything, staff only what they hold; only owners add owners or edit permissions', () => {
    expect(grantablePermissions(owner)).toEqual([...ALL_PARTNER_PERMISSIONS]);
    expect(grantablePermissions(staff)).toEqual(['staff.manage', 'bookings.view']);
    expect(canAddOwner(owner)).toBe(true);
    expect(canAddOwner(staff)).toBe(false);
    expect(canEditPermissions(owner, { role: 'staff', isActive: true })).toBe(true);
    expect(canEditPermissions(owner, { role: 'owner', isActive: true })).toBe(false);
    expect(canEditPermissions(staff, { role: 'staff', isActive: true })).toBe(false);
    expect(canEditPermissions(ADMIN_ACTOR, { role: 'staff', isActive: true })).toBe(true);
  });

  it('route guards: owners pass, staff need any one of the permissions', () => {
    expect(holdsAny(owner, ['finance.view'])).toBe(true);
    expect(holdsAny(staff, ['branches.manage'])).toBe(false);
    expect(holdsAny(staff, ['branches.manage', 'bookings.view'])).toBe(true);
  });

  it('removal: never yourself, owners only by owners, never the last owner', () => {
    expect(removalBlock(owner, { _id: M, role: 'staff' }, 2)).toBe('You cannot remove yourself.');
    expect(removalBlock(staff, { _id: M, role: 'owner' }, 2)).toBe('Only an owner can remove an owner.');
    expect(removalBlock(owner, { _id: 'e5'.repeat(12), role: 'owner' }, 1)).toBe('The last owner cannot be removed.');
    expect(removalBlock(owner, { _id: 'e5'.repeat(12), role: 'owner' }, 2)).toBeNull();
    expect(removalBlock(ADMIN_ACTOR, { _id: M, role: 'staff' }, 1)).toBeNull();
  });

  it('branch scope: a restricted actor hands out only a non-empty subset of its own branches', () => {
    expect(scopeProblem(owner, [])).toBeNull();
    expect(scopeProblem(wideStaff, [])).toBeNull();
    expect(scopeProblem(staff, [])).toBe('Choose at least one of your branches.');
    expect(scopeProblem(staff, ['f6'.repeat(12)])).toBe('You can only give access to your own branches.');
    expect(scopeProblem(staff, [B])).toBeNull();
  });
});
