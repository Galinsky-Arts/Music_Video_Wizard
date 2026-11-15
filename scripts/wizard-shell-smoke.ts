import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DomainVersionKind,
  WizardStepStatus,
  WorkspaceRole
} from "@prisma/client";
import { db } from "../src/lib/db";
import {
  ensureWizardProgress,
  navigateWizard,
  saveWizardStepPayload,
  transitionWizardStep,
  WizardConflictError,
  WizardLockedError
} from "../src/lib/wizard/service";
import { WIZARD_STEPS } from "../src/lib/wizard/registry";
import {
  AnimaticError,
  completeAnimaticReview,
  getAnimaticState
} from "../src/lib/animatic/service";

async function main() {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const projectVersionId = randomUUID();
  const projectNodeId = randomUUID();

  try {
    await db.user.create({
      data: {
        id: userId,
        email: "wizard-" + userId + "@example.test",
        displayName: "Wizard Smoke"
      }
    });
    await db.workspace.create({
      data: {
        id: workspaceId,
        name: "Wizard Smoke Workspace",
        memberships: {
          create: {
            userId,
            role: WorkspaceRole.OWNER
          }
        }
      }
    });
    await db.project.create({
      data: {
        id: projectId,
        workspaceId,
        title: "Original project",
        description: "Original description"
      }
    });
    await db.domainVersionNode.create({
      data: {
        id: projectNodeId,
        kind: DomainVersionKind.PROJECT
      }
    });
    await db.projectVersion.create({
      data: {
        id: projectVersionId,
        projectId,
        nodeId: projectNodeId,
        versionNumber: 1,
        title: "Original project",
        description: "Original description",
        aspectRatio: "16:9",
        outputWidth: 1920,
        outputHeight: 1080,
        frameRate: 24
      }
    });

    const initialized = await ensureWizardProgress({
      userId,
      projectId
    });
    assert.ok(initialized.wizardProgress);
    assert.equal(
      initialized.wizardProgress.steps.length,
      WIZARD_STEPS.length
    );
    assert.equal(initialized.wizardProgress.revision, 0);

    const setupState = initialized.wizardProgress.steps.find(
      (step) => step.stepKey === "project-setup"
    );
    assert.equal(setupState?.status, WizardStepStatus.IN_PROGRESS);

    const saved = await saveWizardStepPayload({
      userId,
      projectId,
      stepKey: "project-setup",
      expectedRevision: 0,
      payload: {
        title: "Autosaved project",
        description: "Autosaved description",
        aspectRatio: "2.39:1",
        frameRate: 24
      }
    });
    assert.equal(saved.progressRevision, 1);
    assert.equal(saved.changed, true);

    const project = await db.project.findUniqueOrThrow({
      where: { id: projectId }
    });
    const version = await db.projectVersion.findUniqueOrThrow({
      where: { id: projectVersionId }
    });
    assert.equal(project.title, "Autosaved project");
    assert.equal(version.outputWidth, 2048);
    assert.equal(version.outputHeight, 858);

    const completed = await transitionWizardStep({
      userId,
      projectId,
      stepKey: "project-setup",
      expectedRevision: 1,
      action: "complete"
    });
    assert.equal(completed.progressRevision, 2);
    assert.equal(completed.status, WizardStepStatus.COMPLETED);

    const progress = await db.wizardProgress.findUniqueOrThrow({
      where: { projectVersionId }
    });
    await db.wizardStepState.update({
      where: {
        wizardProgressId_stepKey: {
          wizardProgressId: progress.id,
          stepKey: "music-analysis"
        }
      },
      data: {
        status: WizardStepStatus.COMPLETED,
        payload: { analysisRevision: 1 },
        completedAt: new Date()
      }
    });

    const reopened = await transitionWizardStep({
      userId,
      projectId,
      stepKey: "project-setup",
      expectedRevision: 2,
      action: "reopen"
    });
    assert.equal(reopened.progressRevision, 3);
    assert.deepEqual(
      reopened.impactWarnings.map((warning) => warning.stepKey),
      ["music-analysis"]
    );

    const downstream = await db.wizardStepState.findUniqueOrThrow({
      where: {
        wizardProgressId_stepKey: {
          wizardProgressId: progress.id,
          stepKey: "music-analysis"
        }
      }
    });
    assert.equal(downstream.status, WizardStepStatus.NEEDS_REVIEW);
    assert.ok(downstream.needsReviewAt);
    assert.match(downstream.reviewReason ?? "", /Project setup/);

    const savedAgain = await saveWizardStepPayload({
      userId,
      projectId,
      stepKey: "project-setup",
      expectedRevision: 3,
      payload: {
        title: "Backtracked project",
        description: "Upstream changed",
        aspectRatio: "16:9",
        frameRate: 30
      }
    });
    assert.equal(savedAgain.progressRevision, 4);

    await transitionWizardStep({
      userId,
      projectId,
      stepKey: "project-setup",
      expectedRevision: 4,
      action: "complete"
    });
    const locked = await transitionWizardStep({
      userId,
      projectId,
      stepKey: "project-setup",
      expectedRevision: 5,
      action: "lock"
    });
    assert.equal(locked.progressRevision, 6);
    assert.equal(locked.locked, true);

    await assert.rejects(
      () =>
        saveWizardStepPayload({
          userId,
          projectId,
          stepKey: "project-setup",
          expectedRevision: 6,
          payload: {
            title: "Should fail",
            description: "",
            aspectRatio: "16:9",
            frameRate: 24
          }
        }),
      WizardLockedError
    );

    await assert.rejects(
      () =>
        transitionWizardStep({
          userId,
          projectId,
          stepKey: "project-setup",
          expectedRevision: 5,
          action: "reopen"
        }),
      WizardConflictError
    );

    await navigateWizard({
      userId,
      projectId,
      stepKey: "concepts"
    });
    const navigated = await db.wizardProgress.findUniqueOrThrow({
      where: { projectVersionId }
    });
    assert.equal(navigated.currentStepKey, "concepts");
    assert.equal(navigated.revision, 6);

    // Existing projects created before a step was added are backfilled.
    await db.wizardStepState.deleteMany({
      where: { wizardProgressId: navigated.id, stepKey: "animatic" }
    });
    const backfilled = await ensureWizardProgress({ userId, projectId });
    assert.ok(
      backfilled.wizardProgress?.steps.some((step) => step.stepKey === "animatic")
    );

    const animatic = await getAnimaticState({ userId, projectId });
    assert.equal(animatic.sourceReady, false);
    assert.equal(animatic.plan, null);
    assert.match(animatic.sourceError ?? "", /Shot Specifications/);
    await assert.rejects(
      completeAnimaticReview({
        userId,
        projectId,
        expectedWizardRevision: navigated.revision
      }),
      AnimaticError
    );
    await assert.rejects(
      getAnimaticState({ userId: randomUUID(), projectId })
    );

    console.log("Wizard shell smoke test passed.");
  } finally {
    await db.projectVersion.deleteMany({ where: { projectId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.domainVersionNode.deleteMany({ where: { id: projectNodeId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
