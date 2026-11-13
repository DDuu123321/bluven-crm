-- The built-in document types were first created with a period of their own: 2 years, the default
-- of the column. A type with a period of its own does not follow the standard period in the
-- settings, so on a database seeded back then that setting did nothing for them. They follow it
-- from now on. A type whose period an admin has set by hand is left alone, even when it reads 2:
-- such a change is in the audit log.
UPDATE "DocumentType" t SET "retentionYears" = NULL
 WHERE t."key" IN ('signed_contract', 'deposit_proof', 'quote', 'electricity_bill', 'install_location', 'meter_box', 'additional_photos', 'other')
   AND t."retentionYears" = 2
   AND NOT EXISTS (
     SELECT 1 FROM "AuditLog" a
      WHERE a."entityType" = 'DocumentType' AND a."entityId" = t."id" AND a."action" = 'document_type.update' AND a."after" ? 'retentionYears');

-- A type created without a period has none: the standard period applies to it.
ALTER TABLE "DocumentType" ALTER COLUMN "retentionYears" DROP DEFAULT;
