-- A file that belonged to a removed contract, or proved a deposit submission that was rejected or
-- withdrawn, stays on record but no longer counts as a current document.
ALTER TABLE "Document" ADD COLUMN     "supersededAt" TIMESTAMP(3);

UPDATE "Document" d SET "supersededAt" = c."voidedAt"
  FROM "Contract" c
 WHERE c."documentId" = d."id" AND c."voidedAt" IS NOT NULL;

UPDATE "Document" d SET "supersededAt" = COALESCE(p."decidedAt", CURRENT_TIMESTAMP)
  FROM "Deposit" p
 WHERE p."proofDocumentId" = d."id" AND p."status" IN ('REJECTED', 'WITHDRAWN');

-- Spacing between attempts to send a notification email.
ALTER TABLE "Notification" ADD COLUMN     "emailLastAttemptAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Hand-written additions
-- ---------------------------------------------------------------------------

-- The audit log cannot be emptied either. (Rows were already protected against UPDATE and DELETE.)
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
