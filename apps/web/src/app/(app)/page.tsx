import { redirect } from 'next/navigation';
import { can } from '@bluven/core';
import { requireSession } from '@/lib/session';

/** Sends each person to the page they work from. */
export default async function Home() {
  const { user } = await requireSession();
  if (can(user, 'dashboard.view')) redirect('/dashboard');
  if (can(user, 'orders.work')) redirect('/orders');
  if (can(user, 'finance.deposits')) redirect('/finance');
  if (can(user, 'ops.handoffs')) redirect('/ops');
  if (can(user, 'admin.users')) redirect('/settings/users');
  redirect('/notifications');
}
