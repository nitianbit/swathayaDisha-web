import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { customerApi, type CustomerProfile, type Gender, type ProfileUpdate } from '@jansetu/api';
import { Alert, Button, ErrorState, Loading, TextField } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../common.tsx';
import { useCustomer, useSession } from '../session.tsx';
import { missingProfileFields } from './HomeScreen.tsx';

const GENDERS: Gender[] = ['Female', 'Male', 'Other'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** YYYYMMDD ⇄ the date input's YYYY-MM-DD. */
const toInput = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');
const fromInput = (v: string) => v.replace(/-/g, '');

export function ProfileScreen() {
  const { api, signOut, signOutEverywhere } = useSession();
  const q = useQuery({ queryKey: ['me'], queryFn: () => customerApi(api).profile() });
  return (
    <>
      <PageHeading title="Profile" />
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <ProfileForm key={q.data._id} profile={q.data} />}
      <section className="card stack" aria-labelledby="fam-h">
        <h2 id="fam-h">Family</h2>
        <Link to="/profile/family">Family members you book for</Link>
      </section>
      <section className="card stack" aria-labelledby="acct-h">
        <h2 id="acct-h">Account</h2>
        <Button variant="secondary" onClick={() => signOut()}>Sign out</Button>
        <Confirm label="Sign out on all devices" confirmLabel="Sign out everywhere"
          consequence="Every phone or browser signed in to your account will be signed out, including this one."
          onConfirm={() => signOutEverywhere()} />
      </section>
    </>
  );
}

function ProfileForm({ profile }: { profile: CustomerProfile }) {
  const { api } = useSession();
  const me = useCustomer();
  const queryClient = useQueryClient();
  const [name, setName] = useState(profile.name ?? '');
  const [email, setEmail] = useState('');
  const [gender, setGender] = useState<Gender | ''>(profile.gender ?? '');
  const [dob, setDob] = useState(toInput(profile.dateOfBirth));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const missing = missingProfileFields(profile);

  const save = useMutation({
    mutationFn: (body: ProfileUpdate) => customerApi(api).updateProfile(me.id, body),
    onSuccess: (user) => queryClient.setQueryData(['me'], user),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const body: ProfileUpdate = {};
    if (name.trim().length < 2) errs.name = 'Enter your full name.'; else if (name.trim() !== (profile.name ?? '')) body.name = name.trim();
    // An email can only be ADDED here; changing an existing one needs support (the server would ignore it).
    if (!profile.email && email.trim()) {
      if (!EMAIL.test(email.trim())) errs.email = 'Enter a valid email address.'; else body.email = email.trim().toLowerCase();
    }
    if (gender && gender !== profile.gender) body.gender = gender;
    if (dob) {
      const v = fromInput(dob);
      if (!/^\d{8}$/.test(v) || v > fromInput(new Date().toISOString().slice(0, 10))) errs.dob = 'Enter your date of birth.';
      else if (v !== profile.dateOfBirth) body.dateOfBirth = v;
    }
    setErrors(errs);
    if (Object.keys(errs).length === 0 && Object.keys(body).length > 0) save.mutate(body);
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="me-h">
      <h2 id="me-h">Your details</h2>
      {missing.length > 0 && <Alert tone="warn">Please complete: {missing.map((m) => LABEL[m]).join(', ')}.</Alert>}
      <TextField label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={100} />
      <div className="field-static"><span>Mobile number</span><strong>{profile.phone ?? '—'}</strong></div>
      {profile.email ? (
        <div className="field-static"><span>Email</span><strong>{profile.email}</strong>
          <small>To change it, contact support.</small></div>
      ) : (
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email}
          hint="Once added, it can only be changed by support." />
      )}
      <fieldset className="choice">
        <legend>Gender</legend>
        {GENDERS.map((g) => (
          <label key={g}><input type="radio" name="gender" checked={gender === g} onChange={() => setGender(g)} /> {g}</label>
        ))}
      </fieldset>
      <TextField label="Date of birth" type="date" value={dob} onChange={(e) => setDob(e.target.value)} error={errors.dob} />
      {save.isError && <Alert>{messageOf(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="ok">Saved.</Alert>}
      <Button type="submit" busy={save.isPending}>Save</Button>
    </form>
  );
}

const LABEL: Record<string, string> = { name: 'name', email: 'email', gender: 'gender', dateOfBirth: 'date of birth' };
