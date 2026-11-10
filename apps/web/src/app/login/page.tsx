import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ActionForm, FormMessage, SubmitButton } from '@/components/client';
import { Input, Label } from '@/components/ui';
import { getCurrentUser } from '@/lib/session';
import { loginAction } from './actions';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect('/');
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-2xl font-semibold tracking-tight text-brand-700">Bluven CRM</p>
          <p className="mt-1 text-sm text-slate-500">Sign in to continue</p>
        </div>
        <ActionForm action={loginAction} keepValues className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <FormMessage />
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <SubmitButton className="w-full" pendingLabel="Signing in…">
            Sign in
          </SubmitButton>
        </ActionForm>
        <p className="mt-4 text-center text-xs text-slate-500">Forgot your password? Ask an administrator to reset it.</p>
      </div>
    </main>
  );
}
