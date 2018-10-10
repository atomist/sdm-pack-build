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
    DefaultHttpClientFactory,
    EventFired,
    GraphQL,
    HandlerContext,
    HandlerResult,
    logger,
    RemoteRepoRef,
    Success,
} from "@atomist/automation-client";
import {
    AddressChannels,
    addressChannelsFor,
    BuildListener,
    BuildListenerInvocation,
    DefaultGoalNameGenerator,
    descriptionFromState,
    findSdmGoalOnCommit,
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrationsAndListeners,
    getGoalDefinitionFrom,
    Goal,
    Implementation,
    ImplementationRegistration,
    IndependentOfEnvironment,
    LogInterpretation,
    reportFailureInterpretation,
    SdmGoalEvent,
    SdmGoalFulfillmentMethod,
    SdmGoalState,
    SideEffect,
    slack,
    SoftwareDeliveryMachine,
    updateGoal,
} from "@atomist/sdm";
import * as stringify from "json-stringify-safe";
import {
    Builder,
    executeBuild,
} from "./support/build/executeBuild";
import {
    BuildStatus,
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
    extends FulfillableGoalWithRegistrationsAndListeners<BuilderRegistration|ExternalBuildRegistration, BuildListener> {

    constructor(goalDetailsOrUniqueName: FulfillableGoalDetails | string
                    = DefaultGoalNameGenerator.generateName("build"),
                ...dependsOn: Goal[]) {

        super({
            ...BuildGoal.definition,
            ...getGoalDefinitionFrom(goalDetailsOrUniqueName, DefaultGoalNameGenerator.generateName("build")),
            displayName: "build",
        }, ...dependsOn);
    }

    public with(registration: BuilderRegistration|ExternalBuildRegistration): this {
        if ((registration as BuilderRegistration).builder) {
            const fulfillment: Implementation = {
                name: DefaultGoalNameGenerator.generateName("builder"),
                goalExecutor: executeBuild((registration as BuilderRegistration).builder),
                ...registration as ImplementationRegistration,
            };
            this.addFulfillment(fulfillment);
        } else {
            const fulfillment: SideEffect = {
                name: (registration as ExternalBuildRegistration).externalTool,
            };
            this.addFulfillment(fulfillment);
        }
        return this;
    }

    public register(sdm: SoftwareDeliveryMachine): void {
        super.register(sdm);
        sdm.addEvent({
            name: `${this.definition.uniqueName}-OnBuildComplete`,
            subscription: GraphQL.subscription("OnBuildComplete"),
            listener: (event, context) => this.handleBuildCompleteEvent(event, context, this),
        });
    }

    public async handleBuildCompleteEvent(event: EventFired<OnBuildComplete.Subscription>,
                                          context: HandlerContext,
                                          goal: Build): Promise<HandlerResult> {
        const build = event.data.Build[0];
        const commit: OnBuildComplete.Commit = build.commit;

        const id = goal.sdm.configuration.sdm.repoRefResolver.toRemoteRepoRef(commit.repo, {sha: commit.sha});
        const sdmGoal = await findSdmGoalOnCommit(context, id, commit.repo.org.provider.providerId, goal);
        const credentials = goal.sdm.configuration.sdm.credentialsResolver.eventHandlerCredentials(context, id);
        const addressChannels: AddressChannels = addressChannelsFor(build.commit.repo, context);
        const bli: BuildListenerInvocation = {
            context,
            id,
            credentials,
            addressChannels,
            build,
        };
        await Promise.all(goal.listeners
            .map(l => l(bli)),
        );
        if (!sdmGoal) {
            logger.debug("No build goal on commit; ignoring someone else's build result");
            return Success;
        }
        if (sdmGoal.fulfillment.method !== SdmGoalFulfillmentMethod.SideEffect &&
            sdmGoal.fulfillment.method !== SdmGoalFulfillmentMethod.Other) {
            logger.debug("This build goal is not set up to be completed based on the build node. %j",
                sdmGoal.fulfillment);
            return Success;
        }
        logger.info("Updating build goal: %s", goal.context);
        await setBuiltContext(context, goal, sdmGoal,
            build.status,
                build.buildUrl);
        if (build.status === "failed" && build.buildUrl) {
            const ac = addressChannelsFor(commit.repo, context);
            await displayBuildLogFailure(id, build, ac, undefined);
        }
        return Success;
    }
}

async function displayBuildLogFailure(id: RemoteRepoRef,
                                      build: { buildUrl?: string, status?: string },
                                      addressChannels: AddressChannels,
                                      logInterpretation: LogInterpretation): Promise<any> {
    const buildUrl = build.buildUrl;
    if (buildUrl) {
        logger.info("Retrieving failed build log from " + buildUrl);
        const httpClient = DefaultHttpClientFactory.create();
        const buildLog =  (await httpClient.exchange(buildUrl)).body as string;
        logger.debug("Do we have a log interpretation? " + !!logInterpretation);
        const interpretation = logInterpretation && logInterpretation.logInterpreter(buildLog);
        logger.debug("What did it say? " + stringify(interpretation));
        await reportFailureInterpretation("external-build", interpretation,
            { log: buildLog, url: buildUrl }, id, addressChannels);

    } else {
        return addressChannels("No build log detected for " + linkToSha(id));
    }
}

function linkToSha(id: RemoteRepoRef): string {
    return slack.url(id.url + "/tree/" + id.sha, id.sha.substr(0, 6));
}

async function setBuiltContext(ctx: HandlerContext,
                               goal: Goal,
                               sdmGoal: SdmGoalEvent,
                               state: BuildStatus,
                               url: string): Promise<any> {
    const newState = buildStatusToSdmGoalState(state);
    return updateGoal(ctx, sdmGoal,
        {
            url,
            state: newState,
            description: descriptionFromState(goal, newState),
        });
}

function buildStatusToSdmGoalState(buildStatus: BuildStatus): SdmGoalState {
    switch (buildStatus) {
        case "passed":
            return SdmGoalState.success;
        case "broken":
        case "failed":
        case "canceled":
            return SdmGoalState.failure;
        default:
            return SdmGoalState.in_process;
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
