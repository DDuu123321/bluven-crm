import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getConfig, isManager } from '@bluven/core';
import { ZOHO_SCOPES, listMailboxes, zohoSettings } from '@bluven/integrations';
import { ActionButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, EmptyState, PageHeader, Table, Td } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { disconnectMailboxAction } from '../../account/email/actions';

export const metadata: Metadata = { title: 'Email' };

export default async function EmailSettingsPage() {
  const { user, ctx } = await requireSession();
  if (!isManager(user)) notFound();
  const config = getConfig();
  const settings = zohoSettings();
  const mailboxes = await listMailboxes(ctx);

  return (
    <>
      <PageHeader title="Email" description="Each salesperson connects their own Zoho mailbox. E-mail with known customers then appears on their orders, and messages written in the CRM go out from the salesperson’s own address." />
      {!settings && (
        <div className="mb-4">
          <Alert tone="amber" title="E-mail is not set up yet">
            Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in the server environment and restart the web and worker processes. Until then nobody can connect a mailbox; everything else works as before.
          </Alert>
        </div>
      )}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connection" />
          <CardBody>
            <Dl
              rows={[
                ['Zoho application', settings ? <Badge key="a" tone="green">Configured</Badge> : <Badge key="a" tone="amber">Missing</Badge>],
                ['Zoho sign-in', config.zoho.accountsUrl],
                ['Zoho Mail', config.zoho.mailUrl],
                ['Mailboxes connected', String(mailboxes.length)],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Setting it up in Zoho" />
          <CardBody className="space-y-2 text-sm text-slate-600">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>
                Open Zoho’s API console for the Australian data centre (api-console.zoho.com.au) and add a client of the type “Server-based Applications”.
              </li>
              <li>
                As the authorised redirect address enter
                <code className="mt-1 block rounded bg-slate-100 px-2 py-1 font-mono text-xs break-all text-slate-900">{config.appUrl}/api/zoho/callback</code>
              </li>
              <li>Put the client id and the client secret Zoho shows in ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET.</li>
              <li>Each salesperson then opens their name at the top right, chooses “Mailbox” and connects their own.</li>
            </ol>
            <p>
              The CRM asks each person for these permissions and no others: <span className="font-mono text-xs text-slate-900">{ZOHO_SCOPES.join(', ')}</span>.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Connected mailboxes" />
        {mailboxes.length === 0 ? (
          <EmptyState title="Nobody has connected a mailbox yet">Salespeople connect their own under their name at the top right.</EmptyState>
        ) : (
          <Table head={['Person', 'Mailbox', 'Connected', 'Last read', 'Status', '']}>
            {mailboxes.map((m) => (
              <tr key={m.userId}>
                <Td className="font-medium text-slate-900">{m.userName}</Td>
                <Td>{m.address}</Td>
                <Td className="whitespace-nowrap text-slate-600">{fmtDateTime(m.connectedAt)}</Td>
                <Td className="whitespace-nowrap text-slate-600">{m.lastOkAt ? fmtDateTime(m.lastOkAt) : 'not yet'}</Td>
                <Td>
                  {m.needsReconnect ? <Badge tone="red">Needs connecting again</Badge> : m.lastError ? <Badge tone="amber">Last read failed</Badge> : <Badge tone="green">Working</Badge>}
                  {m.lastError && <div className="mt-1 max-w-xs text-xs text-slate-500">{m.lastError}</div>}
                </Td>
                <Td className="text-right">
                  <ActionButton action={disconnectMailboxAction.bind(null, m.userId)} variant="link" confirm={`Disconnect ${m.address}? ${m.userName} will have to connect it again to read or send customer e-mail in the CRM.`}>
                    Disconnect
                  </ActionButton>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
