import { redirect } from 'next/navigation';
import { markNotificationsRead } from '@bluven/core';
import { authenticate } from '@/lib/http';

/** Opening a notification marks it as read and takes the user to what it is about. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) redirect('/login');
  const { id } = await params;
  const note = await auth.ctx.db.notification.findFirst({ where: { id, userId: auth.user.id }, select: { href: true } });
  if (!note) redirect('/notifications');
  await markNotificationsRead(auth.ctx, [id]);
  // Only ever follow in-app paths.
  redirect(note.href.startsWith('/') && !note.href.startsWith('//') ? note.href : '/notifications');
}
