/*
 * Copyright © 2019 Atomist, Inc.
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

import {subscription} from "@atomist/automation-client/lib/graph/graphQL";
import {EventFired} from "@atomist/automation-client/lib/HandleEvent";
import {HandlerContext} from "@atomist/automation-client/lib/HandlerContext";
import {HandlerResult, Success} from "@atomist/automation-client/lib/HandlerResult";
import {generateHash} from "@atomist/automation-client/lib/internal/util/string";
import {findSdmGoalOnCommit} from "@atomist/sdm/lib/api-helper/goal/fetchGoalsOnCommit";
import {resolveCredentialsPromise} from "@atomist/sdm/lib/api-helper/machine/handlerRegistrations";
import {AddressChannels, addressChannelsFor} from "@atomist/sdm/lib/api/context/addressChannels";
import {Goal} from "@atomist/sdm/lib/api/goal/Goal";
import {DefaultGoalNameGenerator} from "@atomist/sdm/lib/api/goal/GoalNameGenerator";
import {
    FulfillableGoalDetails, FulfillableGoalWithRegistrationsAndListeners,
    getGoalDefinitionFrom, Implementation,
    ImplementationRegistration,
} from "@atomist/sdm/lib/api/goal/GoalWithFulfillment";
import {IndependentOfEnvironment} from "@atomist/sdm/lib/api/goal/support/environment";
import {BuildListener, BuildListenerInvocation} from "@atomist/sdm/lib/api/listener/BuildListener";
import {SoftwareDeliveryMachine} from "@atomist/sdm/lib/api/machine/SoftwareDeliveryMachine";
import {OnBuildComplete} from "@atomist/sdm/lib/typings/types";
import {
    Builder,
    executeBuild,
} from "./support/build/executeBuild";
import {
    executeCheckBuild,
    setBuildContext,
} from "./support/build/executeCheckBuild";

/**
 * Register a Builder for a certain type of push
 */
export interface BuilderRegistration extends Partial<ImplementationRegistration> {
    builder: Builder;
}

/**
 * Register a Builder for a certain type of push
 */
export interface ExternalBuildRegistration extends Partial<ImplementationRegistration> {
    externalTool: string;
}

/**
 * Goal that performs builds: For example using a Maven or NPM Builder implementation
 */
export class Build
    extends
        FulfillableGoalWithRegistrationsAndListeners<BuilderRegistration | ExternalBuildRegistration, BuildListener> {

    constructor(goalDetailsOrUniqueName: FulfillableGoalDetails | string
                    = DefaultGoalNameGenerator.generateName("build"),
                ...dependsOn: Goal[]) {

        super({
            displayName: "build",
            ...getGoalDefinitionFrom(
                goalDetailsOrUniqueName,
                DefaultGoalNameGenerator.generateName("build"),
                BuildGoal.definition),
        }, ...dependsOn);
    }

    public with(registration: BuilderRegistration | ExternalBuildRegistration): this {
        if ((registration as BuilderRegistration).builder) {
            const fulfillment: Implementation = {
                name: DefaultGoalNameGenerator.generateName("builder"),
                goalExecutor: executeBuild((registration as BuilderRegistration).builder),
                ...registration as ImplementationRegistration,
            };
            this.addFulfillment(fulfillment);
        } else {
            // Side-effected goals can't be restarted; a success from the external system will set them to success
            this.definition.retryFeasible = false;
            const fulfillment: Implementation = {
                ...(registration as ExternalBuildRegistration),
                name: (registration as ExternalBuildRegistration).externalTool,
                goalExecutor: executeCheckBuild(),
            };
            this.addFulfillment(fulfillment);
        }
        return this;
    }

    public register(sdm: SoftwareDeliveryMachine): void {
        super.register(sdm);

        sdm.addEvent({
            name: `OnBuildComplete${generateHash(this.definition.uniqueName)}`,
            description: `Handle build completion for goal ${this.definition.uniqueName}`,
            subscription: subscription("OnBuildComplete"),
            paramsMaker: () => sdm.configuration.sdm.credentialsResolver,
            listener: (event, context) => this.handleBuildCompleteEvent(event, context, this),
        });
    }

    public async handleBuildCompleteEvent(event: EventFired<OnBuildComplete.Subscription>,
                                          context: HandlerContext,
                                          goal: Build): Promise<HandlerResult> {
        const build = event.data.Build[0];
        const commit: OnBuildComplete.Commit = build.commit;

        const id = goal.sdm.configuration.sdm.repoRefResolver.toRemoteRepoRef(commit.repo, { sha: commit.sha });
        const sdmGoal = await findSdmGoalOnCommit(context, id, commit.repo.org.provider.providerId, goal);
        const credentials = await resolveCredentialsPromise(
            goal.sdm.configuration.sdm.credentialsResolver.eventHandlerCredentials(context, id));
        const addressChannels: AddressChannels = addressChannelsFor(build.commit.repo, context);
        const preferences = goal.sdm.configuration.sdm.preferenceStoreFactory(context);
        const configuration = goal.sdm.configuration;
        const bli: BuildListenerInvocation = {
            context,
            id,
            credentials,
            addressChannels,
            preferences,
            build,
            configuration,
        } as any;
        await Promise.all(goal.listeners
            .map(l => l(bli)),
        );
        if (!sdmGoal) {
            return Success;
        }
        // TODO: Do we need to account for this in 2.0?
        // if (build.provider === "sdm") {
        //     return Success;
        // }
        await setBuildContext(context, goal, sdmGoal,
            build.status,
            build.buildUrl);
        return Success;
    }
}

const BuildGoal = new Goal({
    uniqueName: "build",
    environment: IndependentOfEnvironment,
    displayName: "build",
    workingDescription: "Building",
    completedDescription: "Build successful",
    failedDescription: "Build failed",
    isolated: true,
    retryFeasible: true,
});
