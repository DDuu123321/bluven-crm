-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('OK', 'REFUSED', 'FAILED');

-- AlterTable
ALTER TABLE "EmailAttachment" ADD COLUMN     "aiConfidence" TEXT,
ADD COLUMN     "aiKind" TEXT,
ADD COLUMN     "aiNote" TEXT,
ADD COLUMN     "aiReadAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HandoffPackage" ADD COLUMN     "brief" JSONB,
ADD COLUMN     "briefAt" TIMESTAMP(3),
ADD COLUMN     "briefModel" TEXT;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "fieldSources" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT,
    "subjectId" TEXT,
    "userId" TEXT,
    "model" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "failure" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSummary" (
    "orderId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "model" TEXT NOT NULL,
    "coversUntil" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "generatedById" TEXT,
    "handledHints" TEXT[],

    CONSTRAINT "OrderSummary_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "BillReading" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "isBill" BOOLEAN NOT NULL,
    "retailer" TEXT NOT NULL DEFAULT '',
    "nmi" TEXT NOT NULL DEFAULT '',
    "accountHolder" TEXT NOT NULL DEFAULT '',
    "supplyAddress" TEXT NOT NULL DEFAULT '',
    "periodFrom" DATE,
    "periodTo" DATE,
    "usageKwh" DOUBLE PRECISION,
    "dailyKwh" DOUBLE PRECISION,
    "amountCents" INTEGER,
    "tariff" TEXT NOT NULL DEFAULT '',
    "exportKwh" DOUBLE PRECISION,
    "notes" TEXT NOT NULL DEFAULT '',
    "addressMatch" TEXT NOT NULL DEFAULT 'unknown',
    "filled" TEXT[],
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRun_createdAt_idx" ON "AiRun"("createdAt");

-- CreateIndex
CREATE INDEX "AiRun_kind_subjectId_createdAt_idx" ON "AiRun"("kind", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_orderId_createdAt_idx" ON "AiRun"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillReading_documentId_key" ON "BillReading"("documentId");

-- CreateIndex
CREATE INDEX "BillReading_orderId_idx" ON "BillReading"("orderId");

-- CreateIndex
CREATE INDEX "BillReading_propertyId_idx" ON "BillReading"("propertyId");

-- AddForeignKey
ALTER TABLE "OrderSummary" ADD CONSTRAINT "OrderSummary_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillReading" ADD CONSTRAINT "BillReading_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillReading" ADD CONSTRAINT "BillReading_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillReading" ADD CONSTRAINT "BillReading_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
