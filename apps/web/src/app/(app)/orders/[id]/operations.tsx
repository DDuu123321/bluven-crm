import { STAGE_HINT, getOperationsView, type Ctx } from '@bluven/core';
import { AfterInstallation, NoticeList, OpsItemList, OpsNotes } from '@/components/operations';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';

/**
 * What operations has arranged, for the salesperson and the managers to read. Only operations
 * changes any of it, on their own page of the order.
 */
export async function OperationsTab({ ctx, orderId }: { ctx: Ctx; orderId: string }) {
  const view = await getOperationsView(ctx, orderId);
  if (!view) {
    return (
      <Card>
        <EmptyState title="Nothing from operations yet">What operations arranges for this job appears here once they have accepted the order.</EmptyState>
      </Card>
    );
  }
  const open = view.items.filter((i) => !i.done).length;
  const withSales = view.stage === 'RETURNED' || view.stage === 'PUSHED';

  return (
    <div className="space-y-4">
      {withSales ? (
        <Alert tone="amber">
          {view.stage === 'RETURNED' ? 'Operations sent this order back to sales. What they had arranged so far is kept below.' : 'Pushed to operations again. What they had arranged before is kept below.'}
        </Alert>
      ) : (
        <Alert tone={view.stage === 'COMPLETED' ? 'green' : 'blue'}>
          {STAGE_HINT[view.stage]} Accepted {fmtDateTime(view.acceptedAt)}.
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="What operations has arranged"
              description="Kept by operations. They work on these side by side."
              actions={open === 0 ? <Badge tone="green">All settled</Badge> : <Badge tone="slate">{open} open</Badge>}
            />
            <OpsItemList items={view.items} />
          </Card>
          {view.jobDoneAt && (
            <Card>
              <CardHeader title="After the installation" description="Operations and finance see the account. They ask you to chase the balance only when it has not come in." />
              <CardBody>
                <AfterInstallation view={view} />
              </CardBody>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Notes from operations" />
            <CardBody>
              <OpsNotes notes={view.notes} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="E-mails to the customer" description="Sent by themselves at each step: the welcome, the dates, and the thank-you with the request for the balance." />
            <NoticeList notices={view.notices} />
          </Card>
        </div>
      </div>
    </div>
  );
}
