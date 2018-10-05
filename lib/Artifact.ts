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
    HandlerContext,
    HandlerResult,
    Success,
} from "@atomist/automation-client";
import { subscription } from "@atomist/automation-client/lib/graph/graphQL";
import {
    addressChannelsFor,
    ArtifactGoal,
    ArtifactListenerInvocation,
    ArtifactListenerRegisterable,
    DefaultGoalNameGenerator,
    findSdmGoalOnCommit,
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrations,
    getGoalDefinitionFrom,
    Goal,
    logger,
    PushListenerInvocation,
    SdmGoalState,
    SideEffect,
    toArtifactListenerRegistration,
    updateGoal,
} from "@atomist/sdm";
import * as _ from "lodash";
import { OnImageLinked } from "./typings/types";

export interface ArtifactRegistration {
    listeners?: ArtifactListenerRegisterable[];
}

export class Artifact extends FulfillableGoalWithRegistrations<ArtifactRegistration> {
    constructor(goalDetailsOrUniqueName: FulfillableGoalDetails | string
                    = DefaultGoalNameGenerator.generateName("artifact"),
                ...dependsOn: Goal[]) {

        super({
            ...ArtifactGoal.definition,
            ...getGoalDefinitionFrom(goalDetailsOrUniqueName, DefaultGoalNameGenerator.generateName("artifact")),
            displayName: "artifact",
        }, ...dependsOn);

        const fulfillment: SideEffect = {name: "build"};
        this.addFulfillment(fulfillment);
        this.sdm.addEvent({
            name: "FindOnArtifactImageLinked",
            subscription: subscription("OnImageLinked"),
            listener: this.handle,
        });
    }

    private async handle(event: EventFired<OnImageLinked.Subscription>,
                         context: HandlerContext): Promise<HandlerResult> {
        const imageLinked = event.data.ImageLinked[0];
        const commit = imageLinked.commit;
        const image = imageLinked.image;
        const id = this.sdm.configuration.sdm.repoRefResolver.toRemoteRepoRef(
            commit.repo,
            {
                sha: commit.sha,
                branch: commit.pushes[0].branch,
            });

        const artifactSdmGoal = await findSdmGoalOnCommit(
            context,
            id,
            commit.repo.org.provider.providerId,
            this);
        if (!artifactSdmGoal) {
            logger.debug("Context %s not found for %j", this.context, id);
            return Success;
        }

        if (this.registrations.length > 0) {
            const credentials = this.sdm.configuration.sdm.credentialsResolver.eventHandlerCredentials(context, id);
            logger.info("Scanning artifact for %j", id);
            const deployableArtifact = await this.sdm.configuration.sdm.artifactStore.checkout(
                image.imageName,
                id,
                credentials);
            const addressChannels = addressChannelsFor(commit.repo, context);

            await this.sdm.configuration.sdm.projectLoader.doWithProject({
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
                if (!!this.registrations) {
                    const listeners = this.registrations.length > 0 ?
                        _.flatten(this.registrations.map(r => !!r.listeners ? r.listeners : [])) :
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
            description: this.successDescription,
            url: image.imageName,
        });
        logger.info("Updated artifact goal '%s'", artifactSdmGoal.name);
        return Success;
    }
}
