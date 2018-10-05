import {
    EventFired,
    EventHandler,
    GraphQL,
    HandleEvent,
    HandlerContext,
    HandlerResult,
    Success,
} from "@atomist/automation-client";
import {
    addressChannelsFor,
    ArtifactListenerInvocation,
    ArtifactListenerRegisterable,
    findSdmGoalOnCommit,
    Goal,
    logger,
    PushListenerInvocation,
    SdmGoalState,
    SoftwareDeliveryMachineOptions,
    toArtifactListenerRegistration,
    updateGoal,
} from "@atomist/sdm";
import { OnImageLinked } from "@atomist/sdm-core/lib/typings/types";

@EventHandler("Scan when artifact is found", GraphQL.subscription("OnImageLinked"))
export class FindArtifactOnImageLinked implements HandleEvent<OnImageLinked.Subscription> {

    /**
     * The goal to update when an artifact is linked.
     * When an artifact is linked to a commit, the build must be done.
     */
    constructor(public goal: Goal,
                private readonly registrations: ArtifactListenerRegisterable[],
                private readonly options: SoftwareDeliveryMachineOptions) {
    }

    public async handle(event: EventFired<OnImageLinked.Subscription>,
                        context: HandlerContext,
                        params: this): Promise<HandlerResult> {
        const imageLinked = event.data.ImageLinked[0];
        const commit = imageLinked.commit;
        const image = imageLinked.image;
        const id = params.options.repoRefResolver.toRemoteRepoRef(
            commit.repo,
            {
                sha: commit.sha,
                branch: commit.pushes[0].branch,
            });

        const artifactSdmGoal = await findSdmGoalOnCommit(
            context,
            id,
            commit.repo.org.provider.providerId,
            params.goal);
        if (!artifactSdmGoal) {
            logger.debug("Context %s not found for %j", params.goal.context, id);
            return Success;
        }

        if (params.registrations.length > 0) {
            const credentials = this.options.credentialsResolver.eventHandlerCredentials(context, id);
            logger.info("Scanning artifact for %j", id);
            const deployableArtifact = await params.options.artifactStore.checkout(image.imageName, id, credentials);
            const addressChannels = addressChannelsFor(commit.repo, context);

            await params.options.projectLoader.doWithProject({
                credentials,
                id,
                context,
                readOnly: true,
            }, async project => {
                // TODO only handles first push
                const pli: PushListenerInvocation = {
                    id,
                    context,
                    credentials,
                    addressChannels,
                    push: commit.pushes[0],
                    project,
                };
                const ai: ArtifactListenerInvocation = {
                    id,
                    context,
                    addressChannels,
                    deployableArtifact,
                    credentials,
                };
                logger.info("About to invoke %d ArtifactListener registrations", params.registrations.length);
                await Promise.all(params.registrations
                    .map(toArtifactListenerRegistration)
                    .filter(async arl => !arl.pushTest || !!(await arl.pushTest.mapping(pli)))
                    .map(l => l.action(ai)));
            });
        }

        await updateGoal(context, artifactSdmGoal, {
            state: SdmGoalState.success,
            description: params.goal.successDescription,
            url: image.imageName,
        });
        logger.info("Updated artifact goal '%s'", artifactSdmGoal.name);
        return Success;
    }
}
