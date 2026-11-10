import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PASSWORD_MIN_LENGTH, ROLES, ROLE_LABEL, can, type Role } from '@bluven/core';
import { ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Badge, Card, Checkbox, Input, Label, PageHeader, Table, Td } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { createUserAction, resetPasswordAction, updateUserAction } from '../actions';

export const metadata: Metadata = { title: 'Users' };

const ROLE_HELP: Record<Role, string> = {
  SALES: 'Works their own leads and orders.',
  MANAGER: 'Sees every order, assigns leads, configures the checklist.',
  FINANCE: 'Confirms or rejects deposits.',
  OPS: 'Accepts or returns orders pushed by sales.',
  ADMIN: 'Manages users, lead sources and system rules.',
};

function RoleBoxes({ selected }: { selected: readonly string[] }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-slate-600">Roles</legend>
      <div className="space-y-1.5">
        {ROLES.map((role) => (
          <Checkbox
            key={role}
            name="roles"
            value={role}
            defaultChecked={selected.includes(role)}
            label={
              <>
                <span className="font-medium text-slate-900">{ROLE_LABEL[role]}</span> <span className="text-slate-500">{ROLE_HELP[role]}</span>
              </>
            }
          />
        ))}
      </div>
      <FieldError name="roles" />
    </fieldset>
  );
}

export default async function UsersPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'admin.users')) notFound();
  const users = await ctx.db.user.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });

  return (
    <>
      <PageHeader
        title="Users"
        description="People sign in with their email and a password. You set a temporary password; they choose their own at first sign-in."
        actions={
          <Modal trigger="Add user" title="Add a user" variant="primary">
            <ActionForm action={createUserAction} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="new-name">Name</Label>
                  <Input id="new-name" name="name" required autoComplete="off" />
                  <FieldError name="name" />
                </div>
                <div>
                  <Label htmlFor="new-email">Email</Label>
                  <Input id="new-email" name="email" type="email" required autoComplete="off" />
                  <FieldError name="email" />
                </div>
              </div>
              <RoleBoxes selected={['SALES']} />
              <div>
                <Label htmlFor="new-password">Temporary password</Label>
                <Input id="new-password" name="password" type="text" required minLength={PASSWORD_MIN_LENGTH} autoComplete="off" className="font-mono" />
                <p className="mt-1 text-xs text-slate-500">At least {PASSWORD_MIN_LENGTH} characters. Pass it on in person or by phone; they must change it at first sign-in.</p>
                <FieldError name="password" />
              </div>
              <FormMessage />
              <div className="flex justify-end gap-2">
                <CancelButton />
                <SubmitButton>Add user</SubmitButton>
              </div>
            </ActionForm>
          </Modal>
        }
      />
      <Card>
        <Table head={['Name', 'Email', 'Roles', 'Last sign-in', 'Status', '']}>
          {users.map((u) => (
            <tr key={u.id} className={u.isActive ? '' : 'opacity-60'}>
              <Td className="font-medium text-slate-900">{u.name}</Td>
              <Td className="text-slate-600">{u.email}</Td>
              <Td>
                <span className="flex flex-wrap gap-1">
                  {u.roles.map((r) => (
                    <Badge key={r} tone={r === 'ADMIN' ? 'violet' : 'slate'}>
                      {ROLE_LABEL[r]}
                    </Badge>
                  ))}
                </span>
              </Td>
              <Td className="text-slate-600">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : <span className="text-slate-400">never</span>}</Td>
              <Td>
                {!u.isActive ? <Badge tone="red">Deactivated</Badge> : u.mustChangePassword ? <Badge tone="amber">Temporary password</Badge> : <Badge tone="green">Active</Badge>}
              </Td>
              <Td className="text-right">
                <span className="flex justify-end gap-1.5">
                  <Modal trigger="Edit" title={`Edit ${u.name}`} size="sm">
                    <ActionForm action={updateUserAction.bind(null, u.id)} keepValues className="space-y-4">
                      <div>
                        <Label htmlFor={`name-${u.id}`}>Name</Label>
                        <Input id={`name-${u.id}`} name="name" defaultValue={u.name} required />
                        <FieldError name="name" />
                      </div>
                      <RoleBoxes selected={u.roles} />
                      <Checkbox name="isActive" defaultChecked={u.isActive} label="Can sign in. Untick to deactivate: their sessions end at once. Transfer their orders from the Team page." />
                      <FormMessage />
                      <div className="flex justify-end gap-2">
                        <CancelButton />
                        <SubmitButton>Save</SubmitButton>
                      </div>
                    </ActionForm>
                  </Modal>
                  <Modal trigger="Reset password" title={`Reset the password of ${u.name}`} size="sm" description="They are signed out everywhere and must choose a new password at next sign-in.">
                    <ActionForm action={resetPasswordAction.bind(null, u.id)} className="space-y-4">
                      <div>
                        <Label htmlFor={`pw-${u.id}`}>New temporary password</Label>
                        <Input id={`pw-${u.id}`} name="password" type="text" required minLength={PASSWORD_MIN_LENGTH} autoComplete="off" className="font-mono" />
                        <FieldError name="password" />
                      </div>
                      <FormMessage />
                      <div className="flex justify-end gap-2">
                        <CancelButton />
                        <SubmitButton>Reset password</SubmitButton>
                      </div>
                    </ActionForm>
                  </Modal>
                </span>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
