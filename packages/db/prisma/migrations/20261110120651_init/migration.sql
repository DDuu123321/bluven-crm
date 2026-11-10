-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SALES', 'MANAGER', 'FINANCE', 'OPS', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrderStage" AS ENUM ('NEW', 'CONTACTED', 'QUOTED', 'SIGNED', 'DEPOSIT_PENDING', 'DEPOSIT_CONFIRMED', 'PUSHED', 'RETURNED', 'HANDED_OVER');

-- CreateEnum
CREATE TYPE "SideState" AS ENUM ('NONE', 'LOST', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "LeadSourceKind" AS ENUM ('BLUVEN', 'EXTERNAL', 'CSV', 'MANUAL');

-- CreateEnum
CREATE TYPE "LeadReceiptStatus" AS ENUM ('CREATED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "DocScope" AS ENUM ('PROPERTY', 'ORDER');

-- CreateEnum
CREATE TYPE "DocSource" AS ENUM ('UPLOAD', 'EMAIL', 'PYLON', 'AI', 'REUSED');

-- CreateEnum
CREATE TYPE "QuoteSentVia" AS ENUM ('EMAIL', 'PYLON', 'MANUAL');

-- CreateEnum
CREATE TYPE "ContractSource" AS ENUM ('UPLOAD', 'EMAIL', 'PYLON');

-- CreateEnum
CREATE TYPE "DepositMethod" AS ENUM ('BANK_TRANSFER', 'GATEWAY', 'FINANCE');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('NOTE', 'CALL', 'MEETING', 'MESSAGE', 'EMAIL_IN', 'EMAIL_OUT', 'LEAD', 'ASSIGNMENT', 'STAGE_CHANGE', 'DOCUMENT', 'QUOTE', 'CONTRACT', 'DEPOSIT', 'HANDOFF', 'TASK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HandoffDecision" AS ENUM ('PENDING', 'ACCEPTED', 'RETURNED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('NONE', 'PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PylonEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roles" "Role"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEmail" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPhone" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL DEFAULT '',
    "addressLine2" TEXT NOT NULL DEFAULT '',
    "suburb" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "postcode" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT 'AU',
    "addressKey" TEXT,
    "propertyType" TEXT NOT NULL DEFAULT '',
    "nmi" TEXT NOT NULL DEFAULT '',
    "retailer" TEXT NOT NULL DEFAULT '',
    "phase" TEXT NOT NULL DEFAULT '',
    "roofType" TEXT NOT NULL DEFAULT '',
    "storeys" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LeadSourceKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenHash" TEXT,
    "tokenLast4" TEXT,
    "tokenCreatedAt" TIMESTAMP(3),
    "prevTokenHash" TEXT,
    "prevTokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadReceipt" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "LeadReceiptStatus" NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LostReason" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LostReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "stage" "OrderStage" NOT NULL DEFAULT 'NEW',
    "sideState" "SideState" NOT NULL DEFAULT 'NONE',
    "ownerId" TEXT,
    "sourceId" TEXT NOT NULL,
    "sourceDetail" TEXT NOT NULL DEFAULT '',
    "externalLeadId" TEXT,
    "leadDetails" JSONB NOT NULL DEFAULT '{}',
    "attribution" JSONB NOT NULL DEFAULT '{}',
    "leadCreatedAt" TIMESTAMP(3) NOT NULL,
    "isBackfill" BOOLEAN NOT NULL DEFAULT false,
    "possibleDuplicateOfId" TEXT,
    "duplicateDismissedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "firstContactedAt" TIMESTAMP(3),
    "quotedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "firstPushedAt" TIMESTAMP(3),
    "pushedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "handedOverAt" TIMESTAMP(3),
    "returnCount" INTEGER NOT NULL DEFAULT 0,
    "lostReasonId" TEXT,
    "lostNote" TEXT NOT NULL DEFAULT '',
    "lostAt" TIMESTAMP(3),
    "onHoldUntil" DATE,
    "onHoldNote" TEXT NOT NULL DEFAULT '',
    "cancelledAt" TIMESTAMP(3),
    "cancelNote" TEXT NOT NULL DEFAULT '',
    "refundStatus" "RefundStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "lastStaffActivityAt" TIMESTAMP(3) NOT NULL,
    "idleLevel" INTEGER NOT NULL DEFAULT 0,
    "handoffNotes" TEXT NOT NULL DEFAULT '',
    "pylonProjectId" TEXT,
    "pylonProjectUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "pylonDesignId" TEXT,
    "dcWatts" INTEGER,
    "storageWh" INTEGER,
    "totalCents" INTEGER,
    "depositCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "documentId" TEXT,
    "webProposalUrl" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentVia" "QuoteSentVia",
    "isAccepted" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "quoteId" TEXT,
    "documentId" TEXT NOT NULL,
    "signedOn" DATE NOT NULL,
    "source" "ContractSource" NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "method" "DepositMethod" NOT NULL,
    "proofDocumentId" TEXT,
    "receiptUrl" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAmountCents" INTEGER,
    "receivedOn" DATE,
    "bankReference" TEXT NOT NULL DEFAULT '',
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "pylonEventId" TEXT,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentType" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scope" "DocScope" NOT NULL,
    "isRequiredForHandoff" BOOLEAN NOT NULL DEFAULT false,
    "retentionYears" INTEGER DEFAULT 2,
    "neverAutoDelete" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "propertyId" TEXT,
    "typeId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "thumbKey" TEXT,
    "source" "DocSource" NOT NULL DEFAULT 'UPLOAD',
    "note" TEXT NOT NULL DEFAULT '',
    "takenAt" TIMESTAMP(3),
    "replacesId" TEXT,
    "copiedFromId" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" "ActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "remindedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "href" TEXT NOT NULL DEFAULT '',
    "orderId" TEXT,
    "readAt" TIMESTAMP(3),
    "emailStatus" "EmailStatus" NOT NULL DEFAULT 'NONE',
    "emailAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoffPackage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "pushedById" TEXT,
    "pushedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "HandoffDecision" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "returnReason" TEXT NOT NULL DEFAULT '',
    "returnMissing" TEXT[],

    CONSTRAINT "HandoffPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "orderId" TEXT,
    "customerId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PylonEvent" (
    "id" TEXT NOT NULL,
    "pylonEventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PylonEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "resultNote" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PylonEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Counter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "CustomerEmail_email_idx" ON "CustomerEmail"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEmail_customerId_email_key" ON "CustomerEmail"("customerId", "email");

-- CreateIndex
CREATE INDEX "CustomerPhone_normalized_idx" ON "CustomerPhone"("normalized");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPhone_customerId_normalized_key" ON "CustomerPhone"("customerId", "normalized");

-- CreateIndex
CREATE INDEX "Property_customerId_idx" ON "Property"("customerId");

-- CreateIndex
CREATE INDEX "Property_addressKey_idx" ON "Property"("addressKey");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_key_key" ON "LeadSource"("key");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_tokenHash_key" ON "LeadSource"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_prevTokenHash_key" ON "LeadSource"("prevTokenHash");

-- CreateIndex
CREATE INDEX "LeadReceipt_orderId_idx" ON "LeadReceipt"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadReceipt_sourceId_externalId_key" ON "LeadReceipt"("sourceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "LostReason_key_key" ON "LostReason"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNo_key" ON "Order"("orderNo");

-- CreateIndex
CREATE INDEX "Order_ownerId_sideState_stage_idx" ON "Order"("ownerId", "sideState", "stage");

-- CreateIndex
CREATE INDEX "Order_stage_sideState_idx" ON "Order"("stage", "sideState");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE INDEX "Order_propertyId_idx" ON "Order"("propertyId");

-- CreateIndex
CREATE INDEX "Order_sourceId_createdAt_idx" ON "Order"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_pylonProjectId_idx" ON "Order"("pylonProjectId");

-- CreateIndex
CREATE INDEX "Order_lastStaffActivityAt_idx" ON "Order"("lastStaffActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_documentId_key" ON "Quote"("documentId");

-- CreateIndex
CREATE INDEX "Quote_pylonDesignId_idx" ON "Quote"("pylonDesignId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_orderId_version_key" ON "Quote"("orderId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_documentId_key" ON "Contract"("documentId");

-- CreateIndex
CREATE INDEX "Contract_orderId_voidedAt_idx" ON "Contract"("orderId", "voidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_proofDocumentId_key" ON "Deposit"("proofDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_pylonEventId_key" ON "Deposit"("pylonEventId");

-- CreateIndex
CREATE INDEX "Deposit_orderId_idx" ON "Deposit"("orderId");

-- CreateIndex
CREATE INDEX "Deposit_status_submittedAt_idx" ON "Deposit"("status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_key_key" ON "DocumentType"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Document_replacesId_key" ON "Document"("replacesId");

-- CreateIndex
CREATE INDEX "Document_orderId_typeId_idx" ON "Document"("orderId", "typeId");

-- CreateIndex
CREATE INDEX "Document_propertyId_idx" ON "Document"("propertyId");

-- CreateIndex
CREATE INDEX "Document_sha256_idx" ON "Document"("sha256");

-- CreateIndex
CREATE INDEX "Activity_orderId_occurredAt_idx" ON "Activity"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_customerId_occurredAt_idx" ON "Activity"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "Task_assigneeId_status_dueAt_idx" ON "Task"("assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_orderId_status_idx" ON "Task"("orderId", "status");

-- CreateIndex
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_emailStatus_createdAt_idx" ON "Notification"("emailStatus", "createdAt");

-- CreateIndex
CREATE INDEX "HandoffPackage_decision_pushedAt_idx" ON "HandoffPackage"("decision", "pushedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HandoffPackage_orderId_version_key" ON "HandoffPackage"("orderId", "version");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_orderId_at_idx" ON "AuditLog"("orderId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_at_idx" ON "AuditLog"("actorId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_at_idx" ON "AuditLog"("entityType", "entityId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");

-- CreateIndex
CREATE UNIQUE INDEX "PylonEvent_pylonEventId_key" ON "PylonEvent"("pylonEventId");

-- CreateIndex
CREATE INDEX "PylonEvent_status_nextAttemptAt_idx" ON "PylonEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PylonEvent_receivedAt_idx" ON "PylonEvent"("receivedAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerEmail" ADD CONSTRAINT "CustomerEmail_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPhone" ADD CONSTRAINT "CustomerPhone_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadReceipt" ADD CONSTRAINT "LeadReceipt_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LeadSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadReceipt" ADD CONSTRAINT "LeadReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LeadSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_possibleDuplicateOfId_fkey" FOREIGN KEY ("possibleDuplicateOfId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_lostReasonId_fkey" FOREIGN KEY ("lostReasonId") REFERENCES "LostReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_proofDocumentId_fkey" FOREIGN KEY ("proofDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "DocumentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffPackage" ADD CONSTRAINT "HandoffPackage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffPackage" ADD CONSTRAINT "HandoffPackage_pushedById_fkey" FOREIGN KEY ("pushedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffPackage" ADD CONSTRAINT "HandoffPackage_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions
-- ---------------------------------------------------------------------------

-- The audit log is append-only: block UPDATE and DELETE at the database level.
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only (% is not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- At most one live (not voided) contract per order.
CREATE UNIQUE INDEX "Contract_one_live_per_order" ON "Contract" ("orderId") WHERE "voidedAt" IS NULL;

-- At most one open (pending or confirmed) deposit per order.
CREATE UNIQUE INDEX "Deposit_one_open_per_order" ON "Deposit" ("orderId") WHERE "status" IN ('PENDING', 'CONFIRMED');

-- At most one handoff package awaiting a decision per order.
CREATE UNIQUE INDEX "HandoffPackage_one_pending_per_order" ON "HandoffPackage" ("orderId") WHERE "decision" = 'PENDING';
