import type { Metadata } from 'next';
import Link from 'next/link';
import { PASSWORD_MIN_LENGTH } from '@bluven/core';
import { ActionForm, FieldError, FormMessage, SubmitButton } from '@/components/client';
import { Alert, Input, Label } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { changePasswordAction } from '@/app/login/actions';

export const metadata: Metadata = { title: 'Change password' };

export default async function PasswordPage() {
  const { user } = await requireSession({ allowPasswordChange: true });
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">Change your password</h1>
        <p className="mb-4 text-sm text-slate-500">Signed in as {user.email}</p>
        <ActionForm action={changePasswordAction} keepValues className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {user.mustChangePassword && <Alert tone="amber">Your password was set by an administrator. Choose your own before you continue.</Alert>}
          <FormMessage />
          <div>
            <Label htmlFor="current">Current password</Label>
            <Input id="current" name="current" type="password" autoComplete="current-password" required />
            <FieldError name="current" />
          </div>
          <div>
            <Label htmlFor="next">New password</Label>
            <Input id="next" name="next" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} />
            <p className="mt-1 text-xs text-slate-500">At least {PASSWORD_MIN_LENGTH} characters.</p>
            <FieldError name="next" />
          </div>
          <div>
            <Label htmlFor="confirm">New password again</Label>
            <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
            <FieldError name="confirm" />
          </div>
          <SubmitButton className="w-full">Change password</SubmitButton>
        </ActionForm>
        {!user.mustChangePassword && (
          <p className="mt-4 text-center text-xs">
            <Link href="/" className="text-slate-500 hover:text-slate-800">
              Back to the CRM
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
