-- FR-IMP-12: row reports are purged after the retention period; the import log entry remains.
ALTER TABLE "import_jobs" ADD COLUMN "reportPurgedAt" TIMESTAMP(3);
