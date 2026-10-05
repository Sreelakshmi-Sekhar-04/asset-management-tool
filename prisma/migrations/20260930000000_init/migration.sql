-- Sequences backing human-readable identifiers. Sequences never reuse values.
CREATE SEQUENCE IF NOT EXISTS "asset_code_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "transfer_no_seq" START 1;
CREATE SEQUENCE IF NOT EXISTS "approval_no_seq" START 1;


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'IT_OPERATOR', 'BRANCH_USER');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('REGION', 'STATE', 'BRANCH', 'SITE', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_STOCK', 'ASSIGNED', 'UNDER_REPAIR', 'RETIRED');

-- CreateEnum
CREATE TYPE "HolderType" AS ENUM ('EMPLOYEE', 'DEPARTMENT', 'LOCATION');

-- CreateEnum
CREATE TYPE "DisposalType" AS ENUM ('SCRAPPED', 'SOLD', 'DONATED', 'LOST');

-- CreateEnum
CREATE TYPE "MovementKind" AS ENUM ('REGISTERED', 'IMPORTED', 'ASSIGNED', 'CHECKED_IN', 'REPAIR_STARTED', 'REPAIR_COMPLETED', 'RETIRED', 'TRANSFER_RECEIVED', 'TRANSFER_NOT_RECEIVED', 'CORRECTION');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransferLineStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'IN_TRANSIT', 'RECEIVED', 'NOT_RECEIVED', 'RECALLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ExceptionResolution" AS ENUM ('RESENT', 'LOCATED_AT_SENDER', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('ASSET_CREATE', 'ASSIGN', 'CHECK_IN', 'TRANSFER', 'RETIRE', 'STATUS_CHANGE');

-- CreateEnum
CREATE TYPE "ApproverType" AS ENUM ('USER', 'ROLE', 'HOLDER_MANAGER');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalTaskStatus" AS ENUM ('WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RenewableType" AS ENUM ('WARRANTY', 'LICENCE', 'SUBSCRIPTION', 'AMC', 'CALIBRATION', 'INSURANCE', 'CERTIFICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "RenewableStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignScope" AS ENUM ('ALL', 'REGIONS', 'BRANCHES');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "VerificationTaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'SIGNED_OFF');

-- CreateEnum
CREATE TYPE "VerificationResult" AS ENUM ('PRESENT', 'MISSING', 'WRONG_DETAILS');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentEntity" AS ENUM ('ASSET', 'TRANSFER', 'TRANSFER_RECEIPT', 'RENEWABLE', 'VERIFICATION_TASK', 'ORGANISATION');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('ASSETS', 'EMPLOYEES', 'BRANCH_USERS');

-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('CREATE_ONLY', 'CREATE_OR_UPDATE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('QUEUED', 'VALIDATING', 'VALIDATED', 'COMMIT_QUEUED', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RowOutcome" AS ENUM ('CREATED', 'UPDATED', 'UNCHANGED', 'WARNING', 'REJECTED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('DEVICE', 'DIRECTORY');

-- CreateEnum
CREATE TYPE "FieldRule" AS ENUM ('OVERWRITE', 'WARN', 'IGNORE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'ACCEPTED_INCOMING', 'KEPT_CURRENT');

-- CreateEnum
CREATE TYPE "UnmatchedStatus" AS ENUM ('OPEN', 'LINKED', 'CREATED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('INVITE', 'RESET');

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL DEFAULT 'BRANCH',
    "state" TEXT,
    "code" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    "idPath" TEXT NOT NULL,
    "namePath" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serialRequired" BOOLEAN NOT NULL DEFAULT false,
    "individuallyTracked" BOOLEAN NOT NULL DEFAULT true,
    "isSoftware" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "passwordHash" TEXT,
    "locationId" TEXT,
    "employeeId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "departmentId" TEXT,
    "locationId" TEXT,
    "managerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "fieldSources" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL DEFAULT ('AST-'::text || lpad((nextval('asset_code_seq'::regclass))::text, 6, '0'::text)),
    "categoryId" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serialNumber" TEXT,
    "serialNormalized" TEXT,
    "hostname" TEXT,
    "hostnameNormalized" TEXT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "legacyTag" TEXT,
    "legacyTagNormalized" TEXT,
    "purchaseDate" DATE,
    "purchaseCost" DECIMAL(14,2),
    "vendor" TEXT,
    "warrantyEnd" DATE,
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_STOCK',
    "locationId" TEXT,
    "holderType" "HolderType",
    "holderEmployeeId" TEXT,
    "holderDepartmentId" TEXT,
    "holderLocationId" TEXT,
    "preRepairStatus" "AssetStatus",
    "condition" TEXT,
    "remarks" TEXT,
    "sdpTicketId" TEXT,
    "sdpTicketUrl" TEXT,
    "flagTransferException" BOOLEAN NOT NULL DEFAULT false,
    "flagMissing" BOOLEAN NOT NULL DEFAULT false,
    "flagDuplicateSuspect" BOOLEAN NOT NULL DEFAULT false,
    "fieldSources" JSONB NOT NULL DEFAULT '{}',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "importFingerprint" TEXT,
    "retiredAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "retireReason" TEXT,
    "disposalType" "DisposalType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_flags" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "matchedAssetId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,
    "clearReason" TEXT,

    CONSTRAINT "duplicate_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_assignments" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "holderType" "HolderType" NOT NULL,
    "holderId" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" TIMESTAMP(3),
    "assignedById" TEXT,
    "endedById" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',

    CONSTRAINT "asset_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_movements" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "fromLocationId" TEXT,
    "fromLocationName" TEXT,
    "toLocationId" TEXT,
    "toLocationName" TEXT,
    "fromHolderType" "HolderType",
    "fromHolderId" TEXT,
    "fromHolderName" TEXT,
    "toHolderType" "HolderType",
    "toHolderId" TEXT,
    "toHolderName" TEXT,
    "fromStatus" "AssetStatus",
    "toStatus" "AssetStatus",
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorName" TEXT,
    "transferId" TEXT,
    "transferLineId" TEXT,
    "approverName" TEXT,
    "receivedByName" TEXT,
    "reason" TEXT,
    "remarks" TEXT,
    "condition" TEXT,
    "isCorrection" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "asset_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "transferNo" TEXT NOT NULL DEFAULT ('TRF-'::text || lpad((nextval('transfer_no_seq'::regclass))::text, 6, '0'::text)),
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "remarks" TEXT,
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "interState" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "requestedByRole" "Role" NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "effectiveDate" DATE NOT NULL,
    "recordedLate" BOOLEAN NOT NULL DEFAULT false,
    "linkedReference" TEXT,
    "sdpTicketId" TEXT,
    "sdpTicketUrl" TEXT,
    "invoiceNumber" TEXT,
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvalRequestId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approverNames" TEXT,
    "approvalComment" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "completedAt" TIMESTAMP(3),
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "resendOfExceptionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_lines" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "status" "TransferLineStatus" NOT NULL DEFAULT 'DRAFT',
    "assetCode" TEXT NOT NULL,
    "serialNumber" TEXT,
    "make" TEXT,
    "model" TEXT,
    "assetStatusAtDispatch" "AssetStatus",
    "receiptId" TEXT,
    "receivedByName" TEXT,
    "rejectReason" TEXT,
    "remark" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_receipts" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "receivedByName" TEXT NOT NULL,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_exceptions" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "ExceptionResolution",
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resendTransferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minCost" DECIMAL(14,2),
    "minQuantity" INTEGER,
    "interState" BOOLEAN,
    "initiatorRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "approverType" "ApproverType" NOT NULL,
    "approverUserId" TEXT,
    "approverRole" "Role",

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "requestNo" TEXT NOT NULL DEFAULT ('APR-'::text || lpad((nextval('approval_no_seq'::regclass))::text, 6, '0'::text)),
    "action" "ApprovalAction" NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "policyId" TEXT,
    "policyName" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "assetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payload" JSONB NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "initiatorName" TEXT NOT NULL,
    "initiatorRole" "Role" NOT NULL,
    "currentOrder" INTEGER NOT NULL DEFAULT 0,
    "decidedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_tasks" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "approverType" "ApproverType" NOT NULL,
    "approverUserId" TEXT,
    "approverRole" "Role",
    "status" "ApprovalTaskStatus" NOT NULL DEFAULT 'WAITING',
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "reassignedFromUserId" TEXT,

    CONSTRAINT "approval_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewables" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" "RenewableType" NOT NULL,
    "label" TEXT NOT NULL,
    "vendor" TEXT,
    "identifier" TEXT,
    "seats" INTEGER,
    "startDate" DATE,
    "expiryDate" DATE NOT NULL,
    "renewalTermMonths" INTEGER,
    "cost" DECIMAL(14,2),
    "ownerUserId" TEXT,
    "ownerEmployeeId" TEXT,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "status" "RenewableStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceKey" TEXT,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "cycleStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "snoozedUntil" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "renewables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_events" (
    "id" TEXT NOT NULL,
    "renewableId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldExpiry" DATE,
    "newExpiry" DATE,
    "cost" DECIMAL(14,2),
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "renewal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "types" "RenewableType"[] DEFAULT ARRAY[]::"RenewableType"[],
    "leadDays" INTEGER[] DEFAULT ARRAY[90, 30, 7, 1]::INTEGER[],
    "notifyOwner" BOOLEAN NOT NULL DEFAULT true,
    "notifyOwnerManager" BOOLEAN NOT NULL DEFAULT false,
    "roles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "userIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channelInApp" BOOLEAN NOT NULL DEFAULT true,
    "channelEmail" BOOLEAN NOT NULL DEFAULT true,
    "escalationDays" INTEGER,
    "escalationRole" "Role",
    "escalationUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escalateToOwnerManager" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_reminders" (
    "id" TEXT NOT NULL,
    "renewableId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipients" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "renewal_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "scope" "CampaignScope" NOT NULL,
    "scopeLocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recurrenceQuarterly" BOOLEAN NOT NULL DEFAULT false,
    "nextRunAt" DATE,
    "parentId" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "verification_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tasks" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "VerificationTaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,
    "submittedByName" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "signedOffById" TEXT,
    "signedOffByName" TEXT,
    "signOffNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_lines" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "inTransit" BOOLEAN NOT NULL DEFAULT false,
    "result" "VerificationResult",
    "correctedHostname" TEXT,
    "correctedIp" TEXT,
    "correctedHolderEmployeeId" TEXT,
    "correctedRemarks" TEXT,
    "note" TEXT,
    "markedAt" TIMESTAMP(3),
    "markedById" TEXT,
    "reviewStatus" "ReviewStatus",
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "verification_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_unlisted" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serialNumber" TEXT,
    "hostname" TEXT,
    "ipAddress" TEXT,
    "legacyTag" TEXT,
    "remarks" TEXT,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAssetId" TEXT,

    CONSTRAINT "verification_unlisted_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "entityType" "DocumentEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "scanStatus" "ScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
    "description" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "deleteReason" TEXT,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "type" "ImportType" NOT NULL,
    "mode" "ImportMode" NOT NULL DEFAULT 'CREATE_ONLY',
    "createMissing" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'QUEUED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "locationsToCreate" JSONB NOT NULL DEFAULT '[]',
    "departmentsToCreate" JSONB NOT NULL DEFAULT '[]',
    "warningReason" TEXT,
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "committedById" TEXT,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "outcome" "RowOutcome" NOT NULL,
    "messages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchedId" TEXT,
    "resultId" TEXT,
    "resultCode" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_events" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_events_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "integration_sources" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL DEFAULT 'DEVICE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "apiKeyHash" TEXT,
    "apiKeyPrefix" TEXT,
    "apiKeyRevokedAt" TIMESTAMP(3),
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "autoCreate" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateCategoryId" TEXT,
    "autoCreateLocationId" TEXT,
    "secondaryMatchKey" TEXT NOT NULL DEFAULT 'none',
    "pullEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pullIntervalMinutes" INTEGER,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretEnc" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_mappings" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "rule" "FieldRule" NOT NULL DEFAULT 'WARN',

    CONSTRAINT "integration_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_runs" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "batchId" TEXT,
    "payloadHash" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'PUSH',
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "received" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "unmatched" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "retryOfRunId" TEXT,
    "payload" JSONB,

    CONSTRAINT "integration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_conflicts" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL DEFAULT 'ASSET',
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "currentValue" TEXT,
    "incomingValue" TEXT,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "integration_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_unmatched" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT,
    "serialNumber" TEXT,
    "hostname" TEXT,
    "payload" JSONB NOT NULL,
    "status" "UnmatchedStatus" NOT NULL DEFAULT 'OPEN',
    "runId" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "assetId" TEXT,

    CONSTRAINT "integration_unmatched_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_source_data" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "externalId" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "lastSeen" TIMESTAMP(3),
    "currentUser" TEXT,
    "patchStatus" TEXT,
    "lastPatched" TIMESTAMP(3),
    "applications" JSONB NOT NULL DEFAULT '[]',
    "sourceTimestamp" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_source_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "eventKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT,
    "eventKey" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_filters" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityLabel" TEXT,
    "details" JSONB,
    "before" JSONB,
    "after" JSONB,
    "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE INDEX "locations_idPath_idx" ON "locations"("idPath");

-- CreateIndex
CREATE UNIQUE INDEX "locations_parentId_name_key" ON "locations"("parentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "asset_categories_name_key" ON "asset_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_employeeId_key" ON "users"("employeeId");

-- CreateIndex
CREATE INDEX "users_role_active_idx" ON "users"("role", "active");

-- CreateIndex
CREATE INDEX "users_locationId_idx" ON "users"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employeeCode_key" ON "employees"("employeeCode");

-- CreateIndex
CREATE INDEX "employees_name_idx" ON "employees"("name");

-- CreateIndex
CREATE INDEX "employees_locationId_idx" ON "employees"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_assetCode_key" ON "assets"("assetCode");

-- CreateIndex
CREATE UNIQUE INDEX "assets_serialNormalized_key" ON "assets"("serialNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "assets_legacyTagNormalized_key" ON "assets"("legacyTagNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "assets_importFingerprint_key" ON "assets"("importFingerprint");

-- CreateIndex
CREATE INDEX "assets_status_idx" ON "assets"("status");

-- CreateIndex
CREATE INDEX "assets_locationId_status_idx" ON "assets"("locationId", "status");

-- CreateIndex
CREATE INDEX "assets_categoryId_idx" ON "assets"("categoryId");

-- CreateIndex
CREATE INDEX "assets_hostnameNormalized_idx" ON "assets"("hostnameNormalized");

-- CreateIndex
CREATE INDEX "assets_ipAddress_idx" ON "assets"("ipAddress");

-- CreateIndex
CREATE INDEX "assets_holderEmployeeId_idx" ON "assets"("holderEmployeeId");

-- CreateIndex
CREATE INDEX "assets_warrantyEnd_idx" ON "assets"("warrantyEnd");

-- CreateIndex
CREATE INDEX "assets_createdAt_idx" ON "assets"("createdAt");

-- CreateIndex
CREATE INDEX "duplicate_flags_assetId_idx" ON "duplicate_flags"("assetId");

-- CreateIndex
CREATE INDEX "duplicate_flags_matchedAssetId_idx" ON "duplicate_flags"("matchedAssetId");

-- CreateIndex
CREATE INDEX "asset_assignments_assetId_startAt_idx" ON "asset_assignments"("assetId", "startAt");

-- CreateIndex
CREATE INDEX "asset_assignments_holderType_holderId_idx" ON "asset_assignments"("holderType", "holderId");

-- CreateIndex
CREATE INDEX "asset_movements_assetId_effectiveAt_idx" ON "asset_movements"("assetId", "effectiveAt");

-- CreateIndex
CREATE INDEX "asset_movements_effectiveAt_idx" ON "asset_movements"("effectiveAt");

-- CreateIndex
CREATE INDEX "asset_movements_fromLocationId_idx" ON "asset_movements"("fromLocationId");

-- CreateIndex
CREATE INDEX "asset_movements_toLocationId_idx" ON "asset_movements"("toLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_transferNo_key" ON "transfers"("transferNo");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_approvalRequestId_key" ON "transfers"("approvalRequestId");

-- CreateIndex
CREATE INDEX "transfers_status_idx" ON "transfers"("status");

-- CreateIndex
CREATE INDEX "transfers_fromLocationId_status_idx" ON "transfers"("fromLocationId", "status");

-- CreateIndex
CREATE INDEX "transfers_toLocationId_status_idx" ON "transfers"("toLocationId", "status");

-- CreateIndex
CREATE INDEX "transfers_requestedAt_idx" ON "transfers"("requestedAt");

-- CreateIndex
CREATE INDEX "transfer_lines_assetId_status_idx" ON "transfer_lines"("assetId", "status");

-- CreateIndex
CREATE INDEX "transfer_lines_transferId_status_idx" ON "transfer_lines"("transferId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_lines_transferId_assetId_key" ON "transfer_lines"("transferId", "assetId");

-- CreateIndex
CREATE INDEX "transfer_receipts_transferId_idx" ON "transfer_receipts"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_exceptions_lineId_key" ON "transfer_exceptions"("lineId");

-- CreateIndex
CREATE INDEX "transfer_exceptions_status_idx" ON "transfer_exceptions"("status");

-- CreateIndex
CREATE INDEX "transfer_exceptions_assetId_idx" ON "transfer_exceptions"("assetId");

-- CreateIndex
CREATE INDEX "approval_policies_action_active_priority_idx" ON "approval_policies"("action", "active", "priority");

-- CreateIndex
CREATE INDEX "approval_steps_policyId_stepOrder_idx" ON "approval_steps"("policyId", "stepOrder");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_requestNo_key" ON "approval_requests"("requestNo");

-- CreateIndex
CREATE INDEX "approval_requests_status_action_idx" ON "approval_requests"("status", "action");

-- CreateIndex
CREATE INDEX "approval_requests_initiatorId_idx" ON "approval_requests"("initiatorId");

-- CreateIndex
CREATE INDEX "approval_tasks_requestId_stepOrder_idx" ON "approval_tasks"("requestId", "stepOrder");

-- CreateIndex
CREATE INDEX "approval_tasks_status_approverUserId_idx" ON "approval_tasks"("status", "approverUserId");

-- CreateIndex
CREATE INDEX "approval_tasks_status_approverRole_idx" ON "approval_tasks"("status", "approverRole");

-- CreateIndex
CREATE INDEX "renewables_expiryDate_status_idx" ON "renewables"("expiryDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "renewables_assetId_type_sourceKey_key" ON "renewables"("assetId", "type", "sourceKey");

-- CreateIndex
CREATE INDEX "renewal_events_renewableId_idx" ON "renewal_events"("renewableId");

-- CreateIndex
CREATE UNIQUE INDEX "renewal_reminders_renewableId_cycle_tier_key" ON "renewal_reminders"("renewableId", "cycle", "tier");

-- CreateIndex
CREATE INDEX "verification_tasks_locationId_idx" ON "verification_tasks"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tasks_campaignId_locationId_key" ON "verification_tasks"("campaignId", "locationId");

-- CreateIndex
CREATE INDEX "verification_lines_taskId_result_idx" ON "verification_lines"("taskId", "result");

-- CreateIndex
CREATE UNIQUE INDEX "verification_lines_taskId_assetId_key" ON "verification_lines"("taskId", "assetId");

-- CreateIndex
CREATE INDEX "verification_unlisted_taskId_idx" ON "verification_unlisted"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "documents_storageKey_key" ON "documents"("storageKey");

-- CreateIndex
CREATE INDEX "documents_entityType_entityId_idx" ON "documents"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "import_jobs_createdAt_idx" ON "import_jobs"("createdAt");

-- CreateIndex
CREATE INDEX "import_rows_jobId_outcome_idx" ON "import_rows"("jobId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_jobId_rowNumber_key" ON "import_rows"("jobId", "rowNumber");

-- CreateIndex
CREATE INDEX "jobs_status_runAfter_idx" ON "jobs"("status", "runAfter");

-- CreateIndex
CREATE UNIQUE INDEX "integration_sources_key_key" ON "integration_sources"("key");

-- CreateIndex
CREATE UNIQUE INDEX "integration_mappings_sourceId_field_key" ON "integration_mappings"("sourceId", "field");

-- CreateIndex
CREATE INDEX "integration_runs_sourceId_startedAt_idx" ON "integration_runs"("sourceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "integration_runs_sourceId_batchId_key" ON "integration_runs"("sourceId", "batchId");

-- CreateIndex
CREATE INDEX "integration_conflicts_status_idx" ON "integration_conflicts"("status");

-- CreateIndex
CREATE INDEX "integration_conflicts_entityType_entityId_idx" ON "integration_conflicts"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "integration_unmatched_status_idx" ON "integration_unmatched"("status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_unmatched_sourceId_externalId_key" ON "integration_unmatched"("sourceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_source_data_assetId_sourceKey_key" ON "asset_source_data"("assetId", "sourceKey");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_eventKey_key" ON "notifications"("userId", "eventKey");

-- CreateIndex
CREATE INDEX "email_outbox_status_nextAttemptAt_idx" ON "email_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_to_eventKey_key" ON "email_outbox"("to", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "saved_filters_userId_page_name_key" ON "saved_filters"("userId", "page", "name");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_at_idx" ON "audit_log"("entityType", "entityId", "at");

-- CreateIndex
CREATE INDEX "audit_log_actorId_at_idx" ON "audit_log"("actorId", "at");

-- CreateIndex
CREATE INDEX "audit_log_action_at_idx" ON "audit_log"("action", "at");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "asset_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_holderEmployeeId_fkey" FOREIGN KEY ("holderEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_holderDepartmentId_fkey" FOREIGN KEY ("holderDepartmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_holderLocationId_fkey" FOREIGN KEY ("holderLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_flags" ADD CONSTRAINT "duplicate_flags_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_flags" ADD CONSTRAINT "duplicate_flags_matchedAssetId_fkey" FOREIGN KEY ("matchedAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_movements" ADD CONSTRAINT "asset_movements_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "transfer_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_receipts" ADD CONSTRAINT "transfer_receipts_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_exceptions" ADD CONSTRAINT "transfer_exceptions_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "transfer_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "approval_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewables" ADD CONSTRAINT "renewables_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_events" ADD CONSTRAINT "renewal_events_renewableId_fkey" FOREIGN KEY ("renewableId") REFERENCES "renewables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_reminders" ADD CONSTRAINT "renewal_reminders_renewableId_fkey" FOREIGN KEY ("renewableId") REFERENCES "renewables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tasks" ADD CONSTRAINT "verification_tasks_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "verification_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tasks" ADD CONSTRAINT "verification_tasks_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_lines" ADD CONSTRAINT "verification_lines_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "verification_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_unlisted" ADD CONSTRAINT "verification_unlisted_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "verification_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_mappings" ADD CONSTRAINT "integration_mappings_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "integration_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "integration_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_conflicts" ADD CONSTRAINT "integration_conflicts_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "integration_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_unmatched" ADD CONSTRAINT "integration_unmatched_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "integration_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_source_data" ADD CONSTRAINT "asset_source_data_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

