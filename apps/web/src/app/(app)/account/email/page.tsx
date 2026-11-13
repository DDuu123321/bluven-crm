import type { Metadata } from 'next';
import { can } from '@bluven/core';
import { MAILBOX_SCOPE_LABEL, getOwnMailbox, zohoSettings } from '@bluven/integrations';
import { ActionButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, PageHeader, buttonClass } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';
import { disconnectMailboxAction, setMailboxScopeAction } from './actions';

export const metadata: Metadata = { title: 'Your mailbox' };

const PROBLEMS: Record<string, string> = {
  setup: 'E-mail is not set up on this server yet. An administrator has to add the Zoho client id and secret first.',
  role: 'Only salespeople and managers connect a mailbox.',
  state: 'The answer from Zoho did not match a request from this browser. Please try again.',
  declined: 'Zoho did not grant access. Nothing was connected.',
  taken: 'That mailbox is already connected by another user of the CRM.',
  refused: 'Zoho did not accept the sign-in. Please try again.',
  incomplete: 'Zoho did not grant lasting access. Please try again and accept the request.',
  settings: 'Zoho does not accept the settings this server has for it: the client id, the client secret or the address of the data centre. Trying again will not help. Please tell your administrator.',
  wait: 'Zoho asked us to wait before trying again. Please connect in about ten minutes.',
  failed: 'Something went wrong while connecting. Please try again.',
};

export default async function EmailAccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  const sp = await searchParams;
  const configured = !!zohoSettings();
  const allowed = can(user, 'orders.work');
  // Whatever the person's role is now: a mailbox that is still connected is theirs to see and to disconnect.
  const mailbox = await getOwnMailbox(ctx);
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
          {((allowed && configured) || mailbox) && (
            <div className="flex flex-wrap items-center gap-3">
              {allowed && configured && (
                /* A plain link: the browser has to leave for Zoho's own sign-in page. */
                <a href="/api/zoho/connect" className={buttonClass(mailbox && !mailbox.needsReconnect ? 'secondary' : 'primary')}>
                  {mailbox ? 'Connect again' : 'Connect Zoho Mail'}
                </a>
              )}
              {mailbox && (
                <ActionButton action={disconnectMailboxAction.bind(null, undefined)} variant="link" confirm={`Disconnect ${mailbox.address}? New e-mails will no longer reach the CRM and you will not be able to send from it.`}>
                  Disconnect
                </ActionButton>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {mailbox && (
        <Card className="mt-4 max-w-2xl">
          <CardHeader title="What is kept from this mailbox" description="Your choice. It decides whose customers’ mail leaves your mailbox for the CRM, where the people working on those orders can read it." />
          <CardBody className="space-y-3 text-sm text-slate-700">
            <p>
              <span className="font-medium text-slate-900">Now: {MAILBOX_SCOPE_LABEL[mailbox.scope]}.</span>{' '}
              {mailbox.scope === 'OWN'
                ? 'Only e-mail with customers whose orders are or were yours, or whom you have written to from the CRM. E-mail with other salespeople’s customers stays in your mailbox.'
                : 'E-mail with anyone who is on a customer’s record, including customers of other salespeople. This is meant for a mailbox several people share.'}
            </p>
            {mailbox.scope === 'OWN' ? (
              <ActionButton
                action={setMailboxScopeAction.bind(null, 'ALL')}
                variant="secondary"
                size="sm"
                confirm="Keep e-mail with every customer in the CRM? Whoever works on a customer’s order will be able to read your e-mail with any address on that customer’s record, including addresses a colleague added. Choose this only for a mailbox that is shared anyway."
              >
                Keep e-mail with every customer
              </ActionButton>
            ) : (
              <ActionButton action={setMailboxScopeAction.bind(null, 'OWN')} variant="secondary" size="sm" confirm="Keep only e-mail with your own customers from now on? What is already on other customers’ orders stays there.">
                Keep only e-mail with my own customers
              </ActionButton>
            )}
          </CardBody>
        </Card>
      )}

      {mailbox && mailbox.unreadable.length > 0 && (
        <Card className="mt-4 max-w-2xl">
          <CardHeader title="Messages the CRM could not read" description="They are still in your mailbox. The CRM tried several times and has stopped trying." />
          <ul className="divide-y divide-slate-100 text-sm">
            {mailbox.unreadable.slice(0, 20).map((m, i) => (
              <li key={i} className="px-4 py-2">
                <span className="font-medium text-slate-900">{m.subject || '(no subject)'}</span>
                {m.at && <span className="ml-2 text-xs text-slate-500">{fmtDateTime(m.at)}</span>}
                <div className="text-xs text-slate-500">{m.error}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
