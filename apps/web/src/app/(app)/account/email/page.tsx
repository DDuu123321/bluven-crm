import type { Metadata } from 'next';
import { can } from '@bluven/core';
import { getOwnMailbox, zohoSettings } from '@bluven/integrations';
import { ActionButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, PageHeader, buttonClass } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';
import { disconnectMailboxAction } from './actions';

export const metadata: Metadata = { title: 'Your mailbox' };

const PROBLEMS: Record<string, string> = {
  setup: 'E-mail is not set up on this server yet. An administrator has to add the Zoho client id and secret first.',
  role: 'Only salespeople and managers connect a mailbox.',
  state: 'The answer from Zoho did not match a request from this browser. Please try again.',
  declined: 'Zoho did not grant access. Nothing was connected.',
  taken: 'That mailbox is already connected by another user of the CRM.',
  refused: 'Zoho did not accept the sign-in. Please try again.',
  failed: 'Something went wrong while connecting. Please try again.',
};

export default async function EmailAccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  const sp = await searchParams;
  const configured = !!zohoSettings();
  const allowed = can(user, 'orders.work');
  const mailbox = allowed ? await getOwnMailbox(ctx) : null;
  const problem = PROBLEMS[one(sp.problem) ?? ''];

  return (
    <>
      <PageHeader
        title="Your mailbox"
        description="Connect your own Zoho mailbox and your e-mail with customers appears on their orders. You write from the CRM, the message goes out from your address and sits in your sent folder as usual."
      />
      <div className="mb-4 space-y-2">
        {one(sp.connected) && mailbox && <Alert tone="green">Connected. E-mail with your customers from the last two weeks appears on their orders within a few minutes.</Alert>}
        {problem && <Alert tone="red">{problem}</Alert>}
        {!configured && <Alert tone="amber">E-mail is not set up on this server yet. An administrator has to add the Zoho client id and secret (Administration, then Email).</Alert>}
        {mailbox?.needsReconnect && (
          <Alert tone="red" title="Your mailbox has to be connected again">
            Zoho no longer accepts the CRM’s access to {mailbox.address}. Customer e-mails are not reaching their orders until you connect it again.
          </Alert>
        )}
      </div>

      <Card className="max-w-2xl">
        <CardHeader title={mailbox ? mailbox.address : 'No mailbox connected'} />
        <CardBody className="space-y-4">
          {mailbox ? (
            <Dl
              rows={[
                ['Status', mailbox.needsReconnect ? <Badge key="s" tone="red">Needs connecting again</Badge> : mailbox.lastError ? <Badge key="s" tone="amber">Last read failed</Badge> : <Badge key="s" tone="green">Connected</Badge>],
                ['Connected', fmtDateTime(mailbox.connectedAt)],
                ['Last read', mailbox.lastOkAt ? fmtDateTime(mailbox.lastOkAt) : 'not yet, the first read starts within a minute'],
                ...(mailbox.lastError && !mailbox.needsReconnect ? [['Problem', <span key="e" className="text-amber-700">{mailbox.lastError}</span>] as [string, React.ReactNode]] : []),
              ]}
            />
          ) : (
            <p className="text-sm text-slate-600">Nothing is read and nothing can be sent from the CRM until you connect your mailbox.</p>
          )}
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            <li>Only e-mail to or from customers who are in the CRM is kept. Everything else in your mailbox is left alone and is not stored.</li>
            <li>The CRM reads your inbox, your sent folder and folders of your own. It does not delete, move or mark anything.</li>
            <li>You can disconnect at any time. What is already on customers’ orders stays there.</li>
          </ul>
          {allowed && configured && (
            <div className="flex flex-wrap items-center gap-3">
              {/* A plain link: the browser has to leave for Zoho's own sign-in page. */}
              <a href="/api/zoho/connect" className={buttonClass(mailbox && !mailbox.needsReconnect ? 'secondary' : 'primary')}>
                {mailbox ? 'Connect again' : 'Connect Zoho Mail'}
              </a>
              {mailbox && (
                <ActionButton action={disconnectMailboxAction.bind(null, undefined)} variant="link" confirm={`Disconnect ${mailbox.address}? New e-mails will no longer reach the CRM and you will not be able to send from it.`}>
                  Disconnect
                </ActionButton>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}
