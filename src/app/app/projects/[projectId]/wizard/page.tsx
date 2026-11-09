import { AssetStatus } from "@prisma/client";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ProjectSetupEditor } from "@/components/project-setup-editor";
import { MusicAnalysisEditor } from "@/components/music-analysis-editor";
import { MusicMapEditor } from "@/components/music-map-editor";
import { CreativeBriefEditor } from "@/components/creative-brief-editor";
import { ConceptsEditor } from "@/components/concepts-editor";
import { TreatmentEditor } from "@/components/treatment-editor";
import { CreativeLanguageEditor } from "@/components/creative-language-editor";
import { SongPicturePlanEditor } from "@/components/song-picture-plan-editor";
import { SequenceMapEditor } from "@/components/sequence-map-editor";
import { StoryboardEngine } from "@/components/storyboard-engine";
import { ShotSpecificationsEditor } from "@/components/shot-specifications-editor";
import { InitialFramesEditor } from "@/components/initial-frames-editor";
import { VideoClipsEditor } from "@/components/video-clips-editor";
import { FirstCutEditor } from "@/components/first-cut-editor";
import { RefinementEditor } from "@/components/refinement-editor";
import { FinishExportEditor } from "@/components/finish-export-editor";
import { WizardNavigation } from "@/components/wizard-navigation";
import { WizardStageShell } from "@/components/wizard-stage-placeholder";
import { db } from "@/lib/db";
import { createAssetStorage } from "@/lib/storage";
import { projectSetupDraftSchema } from "@/lib/wizard/input";
import { getMusicAnalysisState } from "@/lib/music-analysis/service";
import { getMusicMapState } from "@/lib/music-map/service";
import { getCreativeBriefState } from "@/lib/creative-brief/service";
import { getConceptState } from "@/lib/concepts/service";
import { getTreatmentState } from "@/lib/treatment/service";
import { getCreativeLanguageState } from "@/lib/creative-language/service";
import { getSongPicturePlanState } from "@/lib/song-picture-plan/service";
import { getSequenceMapState } from "@/lib/sequence-map/service";
import { getStoryboardState } from "@/lib/storyboard/service";
import { getShotSpecificationsState } from "@/lib/shot-specifications/service";
import { getInitialFramesState } from "@/lib/initial-frames/service";
import { getVideoClipsState } from "@/lib/video-clips/service";
import { getAutomaticFirstCutState } from "@/lib/first-cut/service";
import { getRefinementState } from "@/lib/refinement/service";
import { getFinishExportState } from "@/lib/finish-export/service";
import { getWizardView } from "@/lib/wizard/service";

export default async function ProjectWizardPage(props: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const { projectId } = await props.params;
  const searchParams = await props.searchParams;
  const view = await getWizardView({
    userId: session.user.id,
    projectId,
    selectedStepKey: searchParams.step
  });

  const audio = view.projectVersion.audioMasterAssetVersionId
    ? await db.assetVersion.findFirst({
        where: {
          id: view.projectVersion.audioMasterAssetVersionId,
          asset: {
            workspace: {
              memberships: {
                some: { userId: session.user.id }
              }
            }
          }
        },
        include: { asset: true }
      })
    : null;

  const audioUrl =
    audio?.status === AssetStatus.READY
      ? await createAssetStorage().getSignedReadUrl(audio.storageKey, 60 * 30)
      : null;

  const selected = view.selected;
  const selectedPayload =
    selected.definition.editor === "project-setup"
      ? projectSetupDraftSchema.parse(selected.state.payload)
      : null;

  const musicAnalysisState =
    selected.definition.editor === "music-analysis"
      ? await getMusicAnalysisState({
          userId: session.user.id,
          projectId
        })
      : null;

  const musicMapState =
    selected.definition.editor === "music-map"
      ? await getMusicMapState({
          userId: session.user.id,
          projectId
        })
      : null;

  const creativeBriefState =
    selected.definition.editor === "creative-brief"
      ? await getCreativeBriefState({
          userId: session.user.id,
          projectId
        })
      : null;

  const conceptState =
    selected.definition.editor === "concepts"
      ? await getConceptState({
          userId: session.user.id,
          projectId
        })
      : null;

  const treatmentState =
    selected.definition.editor === "treatment"
      ? await getTreatmentState({
          userId: session.user.id,
          projectId
        })
      : null;

  const creativeLanguageState =
    selected.definition.editor === "creative-language"
      ? await getCreativeLanguageState({
          userId: session.user.id,
          projectId
        })
      : null;

  const songPicturePlanState =
    selected.definition.editor === "song-picture-plan"
      ? await getSongPicturePlanState({
          userId: session.user.id,
          projectId
        })
      : null;

  const sequenceMapState =
    selected.definition.editor === "sequence-map"
      ? await getSequenceMapState({
          userId: session.user.id,
          projectId
        })
      : null;

  const storyboardState =
    selected.definition.editor === "storyboard"
      ? await getStoryboardState({
          userId: session.user.id,
          projectId
        })
      : null;

  const shotSpecificationsState =
    selected.definition.editor === "shot-specifications"
      ? await getShotSpecificationsState({
          userId: session.user.id,
          projectId
        })
      : null;

  const initialFramesState =
    selected.definition.editor === "initial-frames"
      ? await getInitialFramesState({
          userId: session.user.id,
          projectId
        })
      : null;

  const videoClipsState =
    selected.definition.editor === "video-clips"
      ? await getVideoClipsState({
          userId: session.user.id,
          projectId
        })
      : null;

  const firstCutState =
    selected.definition.editor === "first-cut"
      ? await getAutomaticFirstCutState({
          userId: session.user.id,
          projectId
        })
      : null;

  const refinementState =
    selected.definition.editor === "refinement"
      ? await getRefinementState({
          userId: session.user.id,
          projectId
        })
      : null;

  const finishExportState =
    selected.definition.editor === "finish-export"
      ? await getFinishExportState({
          userId: session.user.id,
          projectId
        })
      : null;

  return (
    <main className="wizardShell">
      <aside className="wizardSidebar">
        <div className="wizardSidebarHeader">
          <Link className="brandLink" href="/app">
            Music Video Wizard
          </Link>
          <p className="wizardProjectName">{view.project.title}</p>
          <p className="wizardProjectVersion">
            Project version {view.projectVersion.versionNumber} ·{" "}
            {view.projectVersion.lifecycle}
          </p>
        </div>

        <WizardNavigation
          projectId={projectId}
          steps={view.steps.map(({ definition, state }) => ({
            key: definition.key,
            ordinal: definition.ordinal,
            phase: definition.phase,
            title: definition.title,
            status: state.status,
            locked: Boolean(state.lockedAt),
            selected: definition.key === selected.definition.key
          }))}
        />
      </aside>

      <section className="wizardWorkspace">
        <div className="wizardWorkspaceTop">
          <div>
            <p className="eyebrow">{selected.definition.phase}</p>
            <h1 className="wizardTitle">{selected.definition.title}</h1>
            <p className="wizardDescription">
              {selected.definition.description}
            </p>
          </div>
          <div className="wizardStateBadges">
            <span>{selected.state.status.replaceAll("_", " ")}</span>
            {selected.state.lockedAt ? <span>Locked</span> : null}
          </div>
        </div>

        {selected.definition.editor === "project-setup" && selectedPayload ? (
          <>
            <section className="dashboardCard wizardAudioCard">
              <p className="dashboardLabel">Finished master audio</p>
              <p className="dashboardValue">
                {audio?.asset.name ?? "Audio unavailable"}
              </p>
              <p className="dashboardNote">
                The song is treated as the immutable master. This wizard plans
                and builds the video around it; it does not edit the music.
              </p>
              {audioUrl ? (
                <audio
                  className="audioPlayer"
                  controls
                  preload="metadata"
                  src={audioUrl}
                >
                  Your browser does not support audio playback.
                </audio>
              ) : null}
            </section>

            <section className="dashboardCard wizardEditorCard">
              <p><Link href={`/app/projects/${projectId}/assembly`}>Have a complete visual edit? Import it for review and export.</Link></p>
              <ProjectSetupEditor
                projectId={projectId}
                initialPayload={selectedPayload}
                initialRevision={view.progress.revision}
                initialStatus={selected.state.status}
                locked={Boolean(selected.state.lockedAt)}
                downstreamImpact={view.downstreamImpact}
              />
            </section>
          </>
        ) : selected.definition.editor === "music-analysis" &&
          musicAnalysisState ? (
          <>
            <section className="dashboardCard wizardAudioCard">
              <p className="dashboardLabel">Immutable master analyzed</p>
              <p className="dashboardValue">
                {audio?.asset.name ?? "Audio unavailable"}
              </p>
              {audioUrl ? (
                <audio
                  className="audioPlayer"
                  controls
                  preload="metadata"
                  src={audioUrl}
                >
                  Your browser does not support audio playback.
                </audio>
              ) : null}
            </section>

            <section className="dashboardCard wizardEditorCard">
              <MusicAnalysisEditor
                projectId={projectId}
                result={musicAnalysisState.latest?.result ?? null}
                analysisVersionNumber={
                  musicAnalysisState.latest?.versionNumber ?? null
                }
                recentJob={musicAnalysisState.recentJob}
                transcriptionAvailable={
                  musicAnalysisState.transcriptionAvailable
                }
                locked={Boolean(selected.state.lockedAt)}
                wizardStatus={selected.state.status}
                wizardRevision={view.progress.revision}
              />
            </section>
          </>
        ) : selected.definition.editor === "music-map" &&
          musicMapState ? (
          <section className="dashboardCard wizardEditorCard">
            <MusicMapEditor
              projectId={projectId}
              hasAnalysis={Boolean(musicMapState.latestAnalysis)}
              latestAnalysisVersionNumber={
                musicMapState.latestAnalysis?.versionNumber ?? null
              }
              needsRebase={musicMapState.needsRebase}
              initialMap={
                musicMapState.latest
                  ? {
                      ...musicMapState.latest,
                      lockedAt:
                        musicMapState.latest.lockedAt?.toISOString() ?? null,
                      createdAt:
                        musicMapState.latest.createdAt.toISOString()
                    }
                  : null
              }
              wizardStatus={selected.state.status}
              wizardLocked={Boolean(selected.state.lockedAt)}
            />
          </section>
        ) : selected.definition.editor === "creative-brief" &&
          creativeBriefState ? (
          <section className="dashboardCard wizardEditorCard">
            <CreativeBriefEditor
              projectId={projectId}
              sourceReady={creativeBriefState.sourceReady}
              latestMusicMap={
                creativeBriefState.latestMusicMap
                  ? {
                      ...creativeBriefState.latestMusicMap,
                      lifecycle:
                        creativeBriefState.latestMusicMap.lifecycle
                    }
                  : null
              }
              needsRebase={creativeBriefState.needsRebase}
              initialVersion={
                creativeBriefState.latest
                  ? {
                      id: creativeBriefState.latest.id,
                      nodeId: creativeBriefState.latest.nodeId,
                      versionNumber:
                        creativeBriefState.latest.versionNumber,
                      lifecycle: creativeBriefState.latest.lifecycle,
                      sourceMusicMapVersionId:
                        creativeBriefState.latest.sourceMusicMapVersionId,
                      sourceMusicMapVersionNumber:
                        creativeBriefState.latest
                          .sourceMusicMapVersionNumber,
                      revision: creativeBriefState.latest.revision,
                      brief: creativeBriefState.latest.brief,
                      sourceMusicMap:
                        creativeBriefState.latest.sourceMusicMap
                    }
                  : null
              }
              wizardStatus={selected.state.status}
              wizardLocked={Boolean(selected.state.lockedAt)}
              downstreamImpact={view.downstreamImpact}
            />
          </section>
        ) : selected.definition.editor === "concepts" &&
          conceptState ? (
          <section className="dashboardCard wizardEditorCard">
            <ConceptsEditor
              projectId={projectId}
              sourceReady={conceptState.sourceReady}
              latestBriefVersionNumber={
                conceptState.latestBrief?.versionNumber ?? null
              }
              needsRebase={conceptState.needsRebase}
              initialSet={
                conceptState.latest
                  ? {
                      ...conceptState.latest,
                      createdAt:
                        conceptState.latest.createdAt.toISOString(),
                      lockedAt:
                        conceptState.latest.lockedAt?.toISOString() ?? null,
                      options: conceptState.latest.options.map((option) => ({
                        ...option,
                        createdAt: option.createdAt.toISOString()
                      }))
                    }
                  : null
              }
              recentJob={conceptState.recentJob}
              providerAvailable={conceptState.providerAvailable}
              wizardStatus={selected.state.status}
              wizardLocked={Boolean(selected.state.lockedAt)}
              downstreamImpact={view.downstreamImpact}
            />
          </section>
        ) : selected.definition.editor === "treatment" &&
          treatmentState ? (
          <section className="dashboardCard wizardEditorCard">
            <TreatmentEditor
              projectId={projectId}
              sourceReady={treatmentState.sourceReady}
              needsRebase={treatmentState.needsRebase}
              initialVersion={
                treatmentState.latest
                  ? {
                      id: treatmentState.latest.id,
                      versionNumber: treatmentState.latest.versionNumber,
                      lifecycle: treatmentState.latest.lifecycle,
                      revision: treatmentState.latest.revision,
                      sourceConceptSetVersionNumber:
                        treatmentState.latest.sourceConceptSetVersionNumber,
                      sourceConceptId: treatmentState.latest.sourceConceptId,
                      selectedConcept: {
                        title: treatmentState.latest.selectedConcept.title,
                        logline: treatmentState.latest.selectedConcept.logline
                      },
                      musicMap: treatmentState.latest.musicMap,
                      treatment: treatmentState.latest.treatment,
                      generationJobId: treatmentState.latest.generationJobId
                    }
                  : null
              }
              recentJob={
                treatmentState.recentJob
                  ? {
                      id: treatmentState.recentJob.id,
                      status: treatmentState.recentJob.status,
                      progressPercent:
                        treatmentState.recentJob.progressPercent,
                      progressMessage:
                        treatmentState.recentJob.progressMessage,
                      errorMessage:
                        treatmentState.recentJob.errorMessage
                    }
                  : null
              }
              providerAvailable={treatmentState.providerAvailable}
              wizardStatus={selected.state.status}
              wizardLocked={Boolean(selected.state.lockedAt)}
              downstreamImpact={view.downstreamImpact}
            />
          </section>
        ) : selected.definition.editor === "creative-language" &&
          creativeLanguageState ? (
          <section className="dashboardCard wizardEditorCard">
            <CreativeLanguageEditor
              projectId={projectId}
              sourceReady={creativeLanguageState.sourceReady}
              needsRebase={creativeLanguageState.needsRebase}
              initialVersion={
                creativeLanguageState.latest
                  ? {
                      id: creativeLanguageState.latest.id,
                      versionNumber:
                        creativeLanguageState.latest.versionNumber,
                      lifecycle:
                        creativeLanguageState.latest.lifecycle,
                      revision:
                        creativeLanguageState.latest.revision,
                      sourceTreatmentVersionId:
                        creativeLanguageState.latest
                          .sourceTreatmentVersionId,
                      sourceTreatmentVersionNumber:
                        creativeLanguageState.latest
                          .sourceTreatmentVersionNumber,
                      document:
                        creativeLanguageState.latest.document,
                      generationJobId:
                        creativeLanguageState.latest
                          .generationJobId
                    }
                  : null
              }
              recentJob={creativeLanguageState.recentJob}
              providerAvailable={
                creativeLanguageState.providerAvailable
              }
              wizardStatus={selected.state.status}
              wizardLocked={Boolean(selected.state.lockedAt)}
              downstreamImpact={view.downstreamImpact}
            />
          </section>
        ) : selected.definition.editor === "song-picture-plan" &&
          songPicturePlanState ? (
          <section className="dashboardCard wizardEditorCard">
            <SongPicturePlanEditor
              projectId={projectId}
              sourceReady={songPicturePlanState.sourceReady}
              needsRebase={songPicturePlanState.needsRebase}
              initialVersion={
                songPicturePlanState.latest
                  ? {
                      id: songPicturePlanState.latest.id,
                      versionNumber: songPicturePlanState.latest.versionNumber,
                      lifecycle: songPicturePlanState.latest.lifecycle,
                      revision: songPicturePlanState.latest.revision,
                      sourceTreatmentVersionId:
                        songPicturePlanState.latest.sourceTreatmentVersionId,
                      sourceTreatmentVersionNumber:
                        songPicturePlanState.latest.sourceTreatmentVersionNumber,
                      sourceCreativeLanguageVersionId:
                        songPicturePlanState.latest
                          .sourceCreativeLanguageVersionId,
                      sourceCreativeLanguageVersionNumber:
                        songPicturePlanState.latest
                          .sourceCreativeLanguageVersionNumber,
                      sourceMusicMapVersionId:
                        songPicturePlanState.latest.sourceMusicMapVersionId,
                      sourceMusicMapVersionNumber:
                        songPicturePlanState.latest.sourceMusicMapVersionNumber,
                      document: songPicturePlanState.latest.document,
                      sourceContext: songPicturePlanState.latest.sourceContext,
                      generationJobId:
                        songPicturePlanState.latest.generationJobId
                    }
                  : null
              }
              recentJob={songPicturePlanState.recentJob}
              providerAvailable={songPicturePlanState.providerAvailable}
              wizardStatus={selected.state.status}
              wizardLocked={Boolean(selected.state.lockedAt)}
              downstreamImpact={view.downstreamImpact}
            />
          </section>
        ) : selected.definition.editor === "sequence-map" &&
          sequenceMapState ? (
          <section className="dashboardCard wizardEditorCard">
            <SequenceMapEditor
              projectId={projectId}
              sourceReady={sequenceMapState.sourceReady}
              needsRebase={sequenceMapState.needsRebase}
              latestSongPicturePlanVersionNumber={
                sequenceMapState.latestSongPicturePlanVersionNumber
              }
              initialMap={sequenceMapState.map}
              wizardRevision={sequenceMapState.wizardRevision}
              wizardStatus={sequenceMapState.wizardStatus}
              wizardLocked={sequenceMapState.wizardLocked}
            />
          </section>
        ) : selected.definition.editor === "storyboard" &&
          storyboardState ? (
          <section className="dashboardCard wizardEditorCard">
            <StoryboardEngine
              projectId={projectId}
              sourceReady={storyboardState.sourceReady}
              providerAvailable={storyboardState.providerAvailable}
              needsRegeneration={storyboardState.needsRegeneration}
              recentJob={storyboardState.recentJob}
              storyboard={storyboardState.storyboard}
              wizardRevision={storyboardState.wizardRevision}
              wizardStatus={storyboardState.wizardStatus}
              wizardLocked={storyboardState.wizardLocked}
            />
          </section>
        ) : selected.definition.editor === "shot-specifications" &&
          shotSpecificationsState ? (
          <section className="dashboardCard wizardEditorCard">
            <ShotSpecificationsEditor
              projectId={projectId}
              sourceReady={shotSpecificationsState.sourceReady}
              providerAvailable={shotSpecificationsState.providerAvailable}
              needsRegeneration={shotSpecificationsState.needsRegeneration}
              recentJob={shotSpecificationsState.recentJob}
              sourceCreativeLanguageVersionId={
                shotSpecificationsState.sourceCreativeLanguageVersionId
              }
              specifications={shotSpecificationsState.specifications.map(
                item => ({
                  ...item,
                  lockedAt: item.lockedAt?.toISOString() ?? null
                })
              )}
              expectedShotCount={shotSpecificationsState.expectedShotCount}
              wizardRevision={shotSpecificationsState.wizardRevision}
              wizardStatus={shotSpecificationsState.wizardStatus}
              wizardLocked={shotSpecificationsState.wizardLocked}
            />
          </section>
        ) : selected.definition.editor === "initial-frames" &&
          initialFramesState ? (
          <section className="dashboardCard wizardEditorCard">
            <InitialFramesEditor
              projectId={projectId}
              sourceReady={initialFramesState.sourceReady}
              providerAvailable={initialFramesState.providerAvailable}
              needsRegeneration={initialFramesState.needsRegeneration}
              expectedFrameCount={initialFramesState.expectedFrameCount}
              frames={initialFramesState.frames.map(item => ({
                ...item,
                createdAt: item.createdAt?.toISOString() ?? null
              }))}
              recentJobs={initialFramesState.recentJobs.map(job => ({
                id: job.id,
                status: job.status,
                progressPercent: job.progressPercent,
                progressMessage: job.progressMessage,
                errorMessage: job.errorMessage,
                modelKey: job.modelKey,
                providerKey: job.providerKey
              }))}
              wizardRevision={initialFramesState.wizardRevision}
              wizardStatus={initialFramesState.wizardStatus}
              wizardLocked={initialFramesState.wizardLocked}
            />
          </section>
        ) : selected.definition.editor === "video-clips" &&
          videoClipsState ? (
          <section className="dashboardCard wizardEditorCard">
            <VideoClipsEditor
              projectId={projectId}
              sourceReady={videoClipsState.sourceReady}
              providerAvailable={videoClipsState.providerAvailable}
              needsRegeneration={videoClipsState.needsRegeneration}
              expectedClipCount={videoClipsState.expectedClipCount}
              clips={videoClipsState.clips.map(item => ({
                ...item,
                createdAt: item.createdAt?.toISOString() ?? null
              }))}
              recentJobs={videoClipsState.recentJobs.map(job => ({
                id: job.id,
                status: job.status,
                progressPercent: job.progressPercent,
                progressMessage: job.progressMessage,
                errorMessage: job.errorMessage,
                modelKey: job.modelKey,
                providerKey: job.providerKey
              }))}
              wizardRevision={videoClipsState.wizardRevision}
              wizardStatus={videoClipsState.wizardStatus}
              wizardLocked={videoClipsState.wizardLocked}
            />
          </section>
        ) : selected.definition.editor === "first-cut" &&
          firstCutState ? (
          <section className="dashboardCard wizardEditorCard">
            <FirstCutEditor
              projectId={projectId}
              audioUrl={audioUrl}
              sourceReady={firstCutState.sourceReady}
              sourceError={firstCutState.sourceError}
              needsRebuild={firstCutState.needsRebuild}
              wizardRevision={firstCutState.wizardRevision}
              wizardStatus={firstCutState.wizardStatus}
              wizardLocked={firstCutState.wizardLocked}
              timeline={firstCutState.timeline}
              version={
                firstCutState.version
                  ? {
                      ...firstCutState.version,
                      createdAt:
                        firstCutState.version.createdAt.toISOString(),
                      lockedAt:
                        firstCutState.version.lockedAt?.toISOString() ?? null
                    }
                  : null
              }
              durationMs={firstCutState.durationMs}
            />
          </section>
        ) : selected.definition.editor === "refinement" &&
          refinementState ? (
          <section className="dashboardCard wizardEditorCard">
            <RefinementEditor
              projectId={projectId}
              audioUrl={audioUrl}
              sourceReady={refinementState.sourceReady}
              needsInitialize={refinementState.needsInitialize}
              wizardRevision={refinementState.wizardRevision}
              wizardStatus={refinementState.wizardStatus}
              wizardLocked={refinementState.wizardLocked}
              sourceFirstCut={refinementState.sourceFirstCut}
              timeline={refinementState.timeline}
              version={
                refinementState.version
                  ? {
                      ...refinementState.version,
                      createdAt:
                        refinementState.version.createdAt.toISOString(),
                      lockedAt:
                        refinementState.version.lockedAt?.toISOString() ?? null,
                      items: refinementState.version.items.map(item => ({
                        ...item,
                        alternatives: item.alternatives.map(alt => ({
                          ...alt,
                          createdAt: alt.createdAt.toISOString()
                        }))
                      }))
                    }
                  : null
              }
              history={refinementState.history.map(entry => ({
                ...entry,
                createdAt: entry.createdAt.toISOString(),
                lockedAt: entry.lockedAt?.toISOString() ?? null
              }))}
            />
          </section>
        ) : selected.definition.editor === "finish-export" &&
          finishExportState ? (
          <section className="dashboardCard wizardEditorCard">
            <FinishExportEditor
              projectId={projectId}
              sourceReady={finishExportState.sourceReady}
              sourceError={finishExportState.sourceError}
              prepared={finishExportState.prepared}
              needsPrepare={finishExportState.needsPrepare}
              manifest={finishExportState.manifest}
              recentJob={
                finishExportState.recentJob
                  ? {
                      ...finishExportState.recentJob,
                      createdAt:
                        finishExportState.recentJob.createdAt.toISOString(),
                      completedAt:
                        finishExportState.recentJob.completedAt?.toISOString() ?? null
                    }
                  : null
              }
              currentMaster={
                finishExportState.currentMaster
                  ? {
                      ...finishExportState.currentMaster,
                      createdAt:
                        finishExportState.currentMaster.createdAt.toISOString(),
                      readyAt:
                        finishExportState.currentMaster.readyAt?.toISOString() ?? null
                    }
                  : null
              }
              renderHistory={finishExportState.renderHistory.map(item => ({
                ...item,
                createdAt: item.createdAt.toISOString(),
                readyAt: item.readyAt?.toISOString() ?? null
              }))}
              wizardRevision={finishExportState.wizardRevision}
              wizardStatus={finishExportState.wizardStatus}
              wizardLocked={finishExportState.wizardLocked}
            />
          </section>
        ) : (
          <section className="dashboardCard wizardEditorCard">
            <WizardStageShell
              title={selected.definition.title}
              description={selected.definition.description}
              status={selected.state.status}
              locked={Boolean(selected.state.lockedAt)}
              downstreamImpact={view.downstreamImpact}
            />
          </section>
        )}
      </section>
    </main>
  );
}
