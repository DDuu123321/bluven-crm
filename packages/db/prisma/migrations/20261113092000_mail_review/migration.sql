-- CreateEnum
CREATE TYPE "EmailScope" AS ENUM ('OWN', 'ALL');

-- AlterTable
ALTER TABLE "CustomerEmail" ADD COLUMN     "unconfirmed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "alertedAt" TIMESTAMP(3),
ADD COLUMN     "problemMessages" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "scope" "EmailScope" NOT NULL DEFAULT 'OWN',
ADD COLUMN     "scopeChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EmailAttachment" ADD COLUMN     "fetchAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerAttachmentId" TEXT;
