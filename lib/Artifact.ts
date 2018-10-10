/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    EventFired,
    GraphQL,
    HandlerContext,
    HandlerResult,
    logger,
    Success,
} from "@atomist/automation-client";
import {
    addressChannelsFor,
    ArtifactListenerInvocation,
    ArtifactListenerRegisterable,
    DefaultGoalNameGenerator,
    findSdmGoalOnCommit,
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrations,
    getGoalDefinitionFrom,
    Goal,
    IndependentOfEnvironment,
    PushListenerInvocation,
    SdmGoalState,
    SideEffect,
    SoftwareDeliveryMachine,
    toArtifactListenerRegistration,
    updateGoal,
} from "@atomist/sdm";
import * as _ from "lodash";
import { OnImageLinked } from "./typings/types";

export interface ArtifactRegistration {
    listeners?: ArtifactListenerRegisterable[];
}

/**
 * This goal is fulfilled by an OnImageLinked event subscription. The Build goal will
 * cause such an event being emitted, but external CI systems can trigger the goal
 * fulfillment as well. On fulfillment, the external URL for the artifact will be
 * put on the goal instance and shown in the client.
 *
 * You can register listeners on this event to trigger when a new artifact is available
 * through this goal.
 */
export class Artifact extends FulfillableGoalWithRegistrations<ArtifactRegistration> {
    constructor(goalDetailsOrUniqueName: FulfillableGoalDetails | string
                    = DefaultGoalNameGenerator.generateName("artifact"),
                ...dependsOn: Goal[]) {

        super({
            ...ArtifactGoal.definition,
            ...getGoalDefinitionFrom(goalDetailsOrUniqueName, DefaultGoalNameGenerator.generateName("artifact")),
            displayName: "artifact",
        }, ...dependsOn);

        const fulfillment: SideEffect = { name: "build" };
        this.addFulfillment(fulfillment);
    }

    public register(sdm: SoftwareDeliveryMachine): void {
        super.register(sdm);

        sdm.addEvent({
            name: `OnImageLinkedHandler`,
            description: `Handle image link events for goal ${this.definition.uniqueName}`,
            subscription: GraphQL.subscription("OnImageLinked"),
            listener: (event, context) => this.handle(event, context, this),
        });
    }

    private async handle(event: EventFired<OnImageLinked.Subscription>,
                         context: HandlerContext,
                         goal: Artifact): Promise<HandlerResult> {
        const imageLinked = event.data.ImageLinked[0];
        const commit = imageLinked.commit;
        const image = imageLinked.image;
        const id = goal.sdm.configuration.sdm.repoRefResolver.toRemoteRepoRef(
            commit.repo,
            {
                sha: commit.sha,
                branch: commit.pushes[0].branch,
            });

        const artifactSdmGoal = await findSdmGoalOnCommit(
            context,
            id,
            commit.repo.org.provider.providerId,
            goal);
        if (!artifactSdmGoal) {
            return Success;
        }

        if (goal.registrations.length > 0) {
            const credentials = goal.sdm.configuration.sdm.credentialsResolver.eventHandlerCredentials(context, id);
            logger.info("Scanning artifact for %j", id);
            const deployableArtifact = await goal.sdm.configuration.sdm.artifactStore.checkout(
                image.imageName,
                id,
                credentials);
            const addressChannels = addressChannelsFor(commit.repo, context);

            await goal.sdm.configuration.sdm.projectLoader.doWithProject({
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
                if (!!goal.registrations) {
                    const listeners = goal.registrations.length > 0 ?
                        _.flatten(goal.registrations.map(r => !!r.listeners ? r.listeners : [])) :
                        [];
                    logger.info("About to invoke %d ArtifactListener registrations", listeners.length);

                    await Promise.all(
                        listeners
                            .map(toArtifactListenerRegistration)
                            .filter(async arl => !arl.pushTest || !!(await arl.pushTest.mapping(pli)))
                            .map(l => l.action(ai)));
                }
            });
        }

        await updateGoal(context, artifactSdmGoal, {
            state: SdmGoalState.success,
            description: goal.successDescription,
            externalUrl: image.imageName,
        });
        logger.info("Updated artifact goal '%s'", artifactSdmGoal.name);
        return Success;
    }
}

const ArtifactGoal = new Goal({
    uniqueName: "artifact",
    environment: IndependentOfEnvironment,
    displayName: "store artifact",
    completedDescription: "Stored artifact",
});
