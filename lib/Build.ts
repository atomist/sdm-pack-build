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

import {
    EventFired,
    GraphQL,
    HandlerContext,
    HandlerResult,
    Success,
} from "@atomist/automation-client";
import { generateHash } from "@atomist/automation-client/lib/internal/util/string";
import {
    AddressChannels,
    addressChannelsFor,
    BuildListener,
    BuildListenerInvocation,
    DefaultGoalNameGenerator,
    findSdmGoalOnCommit,
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrationsAndListeners,
    getGoalDefinitionFrom,
    Goal,
    Implementation,
    ImplementationRegistration,
    IndependentOfEnvironment,
    resolveCredentialsPromise,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import {
    Builder,
    executeBuild,
} from "./support/build/executeBuild";
import {
    executeCheckBuild,
    setBuildContext,
} from "./support/build/executeCheckBuild";
import {
    OnBuildComplete,
} from "./typings/types";

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
            const fulfillment: Implementation = {
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
            subscription: GraphQL.subscription("OnBuildComplete"),
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
        };
        await Promise.all(goal.listeners
            .map(l => l(bli)),
        );
        if (!sdmGoal) {
            return Success;
        }
        if (build.provider === "sdm") {
            return Success;
        }
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
