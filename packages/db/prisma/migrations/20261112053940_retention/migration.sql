-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "summarisedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "retentionKeepUntil" TIMESTAMP(3),
ADD COLUMN     "retentionNudgedAt" TIMESTAMP(3),
ADD COLUMN     "retentionRemindedAt" TIMESTAMP(3),
ADD COLUMN     "retentionRemindedFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dailySummary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dailySummaryOn" DATE;

-- CreateIndex
CREATE INDEX "Document_storageKey_idx" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_purgedAt_deletedAt_idx" ON "Document"("purgedAt", "deletedAt");
