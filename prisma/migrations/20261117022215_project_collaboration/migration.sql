-- CreateEnum
CREATE TYPE "ProjectCollaboratorRole" AS ENUM ('EDITOR', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ReviewTargetKind" AS ENUM ('PROJECT', 'SHOT', 'CUT');

-- CreateEnum
CREATE TYPE "ReviewApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'CANCELED');

-- CreateTable
CREATE TABLE "ProjectCollaborator" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ProjectCollaboratorRole" NOT NULL,
    "invitedByUserId" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectInvitation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "ProjectCollaboratorRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedByUserId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "accessExpiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewComment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "authorUserId" UUID,
    "targetKind" "ReviewTargetKind" NOT NULL,
    "shotId" UUID,
    "timelineVersionId" UUID,
    "timecodeMs" INTEGER,
    "body" TEXT NOT NULL,
    "parentCommentId" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "editedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewApprovalRequest" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "requestedByUserId" UUID,
    "targetKind" "ReviewTargetKind" NOT NULL,
    "shotId" UUID,
    "timelineVersionId" UUID,
    "note" TEXT,
    "status" "ReviewApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectCollaborator_userId_idx" ON "ProjectCollaborator"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCollaborator_projectId_userId_key" ON "ProjectCollaborator"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectInvitation_tokenHash_key" ON "ProjectInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "ProjectInvitation_projectId_createdAt_idx" ON "ProjectInvitation"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewComment_projectId_targetKind_createdAt_idx" ON "ReviewComment"("projectId", "targetKind", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewComment_shotId_idx" ON "ReviewComment"("shotId");

-- CreateIndex
CREATE INDEX "ReviewComment_timelineVersionId_idx" ON "ReviewComment"("timelineVersionId");

-- CreateIndex
CREATE INDEX "ReviewApprovalRequest_projectId_status_createdAt_idx" ON "ReviewApprovalRequest"("projectId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ProjectCollaborator" ADD CONSTRAINT "ProjectCollaborator_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCollaborator" ADD CONSTRAINT "ProjectCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_parentCommentId_fkey" FOREIGN KEY ("parentCommentId") REFERENCES "ReviewComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalRequest" ADD CONSTRAINT "ReviewApprovalRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalRequest" ADD CONSTRAINT "ReviewApprovalRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApprovalRequest" ADD CONSTRAINT "ReviewApprovalRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
