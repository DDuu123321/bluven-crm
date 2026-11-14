-- The flow as the business runs it. A salesperson opens the job and says where the customer came
-- from, follows up, has the system designed, sends the proposal and files the proof of the
-- deposit. Operations accepts the order, arranges the installation, marks the job as done and
-- closes it when the balance has arrived. The signed contract and the confirmation by finance
-- are no longer steps of their own.

-- New facts on the order.
ALTER TABLE "Order" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedById" TEXT,
ADD COLUMN     "depositAt" TIMESTAMP(3),
ADD COLUMN     "designAt" TIMESTAMP(3),
ADD COLUMN     "jobDoneAt" TIMESTAMP(3),
ADD COLUMN     "jobDoneById" TEXT,
ADD COLUMN     "leadOriginId" TEXT,
ADD COLUMN     "leadOriginNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "openedAt" TIMESTAMP(3),
ADD COLUMN     "openedById" TEXT;

-- CreateTable
CREATE TABLE "LeadOrigin" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeadOrigin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsJob" (
    "orderId" TEXT NOT NULL,
    "caStatus" TEXT NOT NULL DEFAULT 'TODO',
    "caReference" TEXT NOT NULL DEFAULT '',
    "stcPlatform" TEXT,
    "stcReference" TEXT NOT NULL DEFAULT '',
    "installerName" TEXT NOT NULL DEFAULT '',
    "electricianLicence" TEXT NOT NULL DEFAULT '',
    "installDate" DATE,
    "deliveryMode" TEXT,
    "deliveryEta" DATE,
    "purchaseStatus" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "rebateAppliedAt" TIMESTAMP(3),
    "rebateAppliedById" TEXT,
    "rebateRemindedAt" TIMESTAMP(3),
    "balanceRemindedAt" TIMESTAMP(3),
    "balanceChaseAskedAt" TIMESTAMP(3),
    "balanceChaseAskedById" TEXT,
    "finalAmountCents" INTEGER,
    "finalReceivedOn" DATE,
    "finalNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "OpsJob_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "CustomerNotice" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "toAddress" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "emailMessageId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "CustomerNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadOrigin_key_key" ON "LeadOrigin"("key");

-- CreateIndex
CREATE INDEX "OpsJob_installDate_idx" ON "OpsJob"("installDate");

-- CreateIndex
CREATE INDEX "CustomerNotice_status_nextAttemptAt_idx" ON "CustomerNotice"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CustomerNotice_orderId_createdAt_idx" ON "CustomerNotice"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_leadOriginId_fkey" FOREIGN KEY ("leadOriginId") REFERENCES "LeadOrigin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsJob" ADD CONSTRAINT "OpsJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNotice" ADD CONSTRAINT "CustomerNotice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What is on record is carried over.

-- An order somebody has worked on counts as opened, by its salesperson, when the work began.
-- Where the customer came from is not known for these: it shows as not recorded until someone fills it in.
UPDATE "Order" o
SET "openedAt" = COALESCE(o."firstContactedAt", o."assignedAt", o."createdAt"), "openedById" = o."ownerId"
WHERE o."stage" <> 'NEW'
   OR o."pylonProjectId" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "Quote" q WHERE q."orderId" = o."id")
   OR EXISTS (SELECT 1 FROM "Deposit" d WHERE d."orderId" = o."id" AND d."status" IN ('PENDING', 'CONFIRMED'));

-- The sale counts from the day the deposit on record was recorded.
UPDATE "Order" o
SET "depositAt" = d."at"
FROM (SELECT "orderId", MAX("submittedAt") AS "at" FROM "Deposit" WHERE "status" IN ('PENDING', 'CONFIRMED') GROUP BY "orderId") d
WHERE d."orderId" = o."id";

-- A signed contract means that a proposal went out, also where that was never recorded.
UPDATE "Order" o
SET "quotedAt" = c."at"
FROM (SELECT "orderId", MIN("createdAt") AS "at" FROM "Contract" WHERE "voidedAt" IS NULL GROUP BY "orderId") c
WHERE c."orderId" = o."id" AND o."quotedAt" IS NULL;

-- The design had started wherever there is a Pylon project or a quote version.
UPDATE "Order" o
SET "designAt" = COALESCE((SELECT MIN(q."createdAt") FROM "Quote" q WHERE q."orderId" = o."id"), o."openedAt", o."createdAt")
WHERE o."pylonProjectId" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "Quote" q WHERE q."orderId" = o."id");

-- The stages. Every old one has a place among the new ones, so that the column can change its
-- type. The statement after it then works each order's stage out from its facts, the way the
-- application does from now on.
CREATE TYPE "OrderStage_new" AS ENUM ('NEW', 'FOLLOW_UP', 'DESIGN', 'PROPOSAL_SENT', 'DEPOSIT_PAID', 'PUSHED', 'RETURNED', 'IN_PROGRESS', 'INSTALLED', 'COMPLETED');
ALTER TABLE "Order" ALTER COLUMN "stage" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "stage" TYPE "OrderStage_new" USING (
  CASE "stage"::text
    WHEN 'CONTACTED' THEN 'FOLLOW_UP'
    WHEN 'QUOTED' THEN 'PROPOSAL_SENT'
    WHEN 'SIGNED' THEN 'PROPOSAL_SENT'
    WHEN 'DEPOSIT_PENDING' THEN 'DEPOSIT_PAID'
    WHEN 'DEPOSIT_CONFIRMED' THEN 'DEPOSIT_PAID'
    WHEN 'PUSHED' THEN 'PUSHED'
    WHEN 'RETURNED' THEN 'RETURNED'
    WHEN 'HANDED_OVER' THEN 'IN_PROGRESS'
    ELSE 'NEW'
  END::"OrderStage_new"
);
ALTER TYPE "OrderStage" RENAME TO "OrderStage_old";
ALTER TYPE "OrderStage_new" RENAME TO "OrderStage";
DROP TYPE "OrderStage_old";
ALTER TABLE "Order" ALTER COLUMN "stage" SET DEFAULT 'NEW';

UPDATE "Order" o
SET "stage" = (
  CASE
    WHEN h."decision" = 'ACCEPTED' THEN 'IN_PROGRESS'
    WHEN h."decision" = 'PENDING' THEN 'PUSHED'
    WHEN h."decision" = 'RETURNED' THEN 'RETURNED'
    WHEN o."openedAt" IS NULL THEN 'NEW'
    WHEN EXISTS (SELECT 1 FROM "Deposit" d WHERE d."orderId" = o."id" AND d."status" IN ('PENDING', 'CONFIRMED')) THEN 'DEPOSIT_PAID'
    WHEN o."quotedAt" IS NOT NULL THEN 'PROPOSAL_SENT'
    WHEN o."designAt" IS NOT NULL THEN 'DESIGN'
    ELSE 'FOLLOW_UP'
  END
)::"OrderStage"
FROM "Order" o2
LEFT JOIN LATERAL (
  SELECT hp."decision" FROM "HandoffPackage" hp WHERE hp."orderId" = o2."id" ORDER BY hp."version" DESC LIMIT 1
) h ON true
WHERE o2."id" = o."id";

-- Orders that operations has accepted get the record operations works in.
INSERT INTO "OpsJob" ("orderId", "updatedAt")
SELECT o."id", CURRENT_TIMESTAMP FROM "Order" o WHERE o."stage" = 'IN_PROGRESS';
