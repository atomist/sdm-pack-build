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

import {configurationValue} from "@atomist/automation-client/lib/configuration";
import {HandlerContext} from "@atomist/automation-client/lib/HandlerContext";
import {failure, Success} from "@atomist/automation-client/lib/HandlerResult";
import {ProjectOperationCredentials} from "@atomist/automation-client/lib/operations/common/ProjectOperationCredentials";
import {RemoteRepoRef} from "@atomist/automation-client/lib/operations/common/RepoId";
import {QueryNoCacheOptions} from "@atomist/automation-client/lib/spi/graph/GraphClient";
import {addressEvent} from "@atomist/automation-client/lib/spi/message/MessageClient";
import {logger} from "@atomist/automation-client/lib/util/logger";
import {createGitTag} from "@atomist/sdm-core/lib/internal/delivery/build/executeTag";
import {readSdmVersion} from "@atomist/sdm-core/lib/internal/delivery/build/local/projectVersioner";
import {isInLocalMode} from "@atomist/sdm-core/lib/internal/machine/modes";
import {postWebhook} from "@atomist/sdm-core/lib/util/webhook/ImageLink";
import {SpawnLogResult} from "@atomist/sdm/lib/api-helper/misc/child_process";
import {doWithProject} from "@atomist/sdm/lib/api-helper/project/withProject";
import {ExecuteGoalResult} from "@atomist/sdm/lib/api/goal/ExecuteGoalResult";
import {ExecuteGoal, GoalInvocation} from "@atomist/sdm/lib/api/goal/GoalInvocation";
import {SdmGoalEvent} from "@atomist/sdm/lib/api/goal/SdmGoalEvent";
import {SdmBuildIdentifier} from "@atomist/sdm/lib/typings/types";
import {SdmBuildIdentifierForRepo} from "../../typings/types";
import {AppInfo} from "./AppInfo";

/**
 * Result of a Builder invocation
 */
export interface BuildInProgress {

    /** Result of running the build */
    readonly buildResult: SpawnLogResult;

    /** Available once build is complete */
    readonly appInfo: AppInfo;

    /** Deployment unit file name produced by the build */
    readonly deploymentUnitFile: string;
}

/**
 *  Called to do the actual build, via eg. calling Maven, Gradle or TSC.
 *
 *  All handling of versioning, tagging and setting of statuses is handled outside of the this function.
 */
export type Builder = (goalInvocation: GoalInvocation, buildNo: string) => Promise<BuildInProgress>;

/**
 * Execute build with the appropriate Builder instance
 * This implementation handles sending of Atomist build events and tagging out of the box.
 *
 * @param builder builder to use
 */
export function executeBuild(builder: Builder): ExecuteGoal {
    return async (goalInvocation: GoalInvocation) => {
        const { goalEvent, id, context, progressLog } = goalInvocation;

        logger.info("Building project '%s/%s' with builder '%s'", id.owner, id.repo, builder.name);

        const buildNumber = await obtainBuildIdentifier(goalEvent, context);

        try {
            await updateBuildStatus("started", goalEvent, progressLog.url, buildNumber, context.workspaceId);
            const rb = await builder(goalInvocation, buildNumber);
            try {
                const br = rb.buildResult;
                progressLog.write(
                    `Build result: ${br.error ? "Error" : "Success"}${br.message ? " " + br.message : ""}`);
                await onExit(goalInvocation, !br.error, rb, buildNumber);
                return br.error ? { code: 1, message: br.message } : Success;
            } catch (err) {
                logger.warn("Build on branch %s failed on run: %j - %s", goalEvent.branch, id, err.message);
                progressLog.write(`Build failed with: ${err.message}`);
                progressLog.write(err.stack);
                await onExit(goalInvocation, false, rb, buildNumber);
                return failure(err);
            }
        } catch (err) {
            // If we get here, the build failed before even starting
            logger.warn("Build on branch %s failed on start: %j - %s", goalEvent.branch, id, err.message);
            progressLog.write(`Build failed on start: ${err.message}`);
            await updateBuildStatus("failed", goalEvent, progressLog.url, buildNumber, context.workspaceId);
            return failure(err);
        }
    };
}

async function onExit(gi: GoalInvocation,
                      success: boolean,
                      runningBuild: BuildInProgress,
                      buildNo: string): Promise<any> {
    const { goalEvent, credentials, id, context, progressLog } = gi;
    try {
        if (success) {
            await updateBuildStatus("passed", goalEvent, progressLog.url, buildNo, context.workspaceId);
            await createBuildTag(id, goalEvent, buildNo, context, credentials, gi);
            if (!!runningBuild.deploymentUnitFile
                && configurationValue<boolean>("sdm.build.imageLink", true)) {
                await linkArtifact(gi, runningBuild);
            }
        } else {
            await updateBuildStatus("failed", goalEvent, progressLog.url, buildNo, context.workspaceId);
        }
    } catch (err) {
        logger.warn("Unexpected build exit error: %s", err);
    }
}

async function obtainBuildIdentifier(sdmGoal: SdmGoalEvent,
                                     ctx: HandlerContext): Promise<string> {
    const result = await ctx.graphClient.query<SdmBuildIdentifierForRepo.Query, SdmBuildIdentifierForRepo.Variables>({
        name: "SdmBuildIdentifierForRepo",
        variables: {
            owner: [sdmGoal.repo.owner],
            name: [sdmGoal.repo.name],
            providerId: [sdmGoal.repo.providerId],
        },
        options: QueryNoCacheOptions,
    });

    let buildIdentifier: SdmBuildIdentifier;
    if (result.SdmBuildIdentifier && result.SdmBuildIdentifier.length === 1) {
        buildIdentifier = result.SdmBuildIdentifier[0];
    } else {
        buildIdentifier = {
            identifier: "0",
            repo: {
                owner: sdmGoal.repo.owner,
                name: sdmGoal.repo.name,
                providerId: sdmGoal.repo.providerId,
            },
        };
    }

    const bumpedBuildIdentifier = {
        ...buildIdentifier,
        identifier: (+buildIdentifier.identifier + 1).toString(),
    };
    await ctx.messageClient.send(bumpedBuildIdentifier, addressEvent("SdmBuildIdentifier"));
    return bumpedBuildIdentifier.identifier;
}

async function createBuildTag(id: RemoteRepoRef,
                              sdmGoal: SdmGoalEvent,
                              buildNo: string,
                              context: HandlerContext,
                              credentials: ProjectOperationCredentials,
                              gi: GoalInvocation): Promise<ExecuteGoalResult | void> {
    if (configurationValue<boolean>("sdm.build.tag", true) && !isInLocalMode()) {
        const version = await readSdmVersion(
            sdmGoal.repo.owner,
            sdmGoal.repo.name,
            sdmGoal.repo.providerId,
            sdmGoal.sha,
            sdmGoal.branch,
            context);
        if (version) {
            // TODO: does this work?
            return doWithProject(async gi2 => {
                await createGitTag({
                    project: gi2.project,
                    message: "Tag created by SDM",
                    tag: `${version}+sdm.${buildNo}`,
                });
            })(gi);
        }
    }
}

async function linkArtifact(gi: GoalInvocation,
                            rb: BuildInProgress): Promise<void> {
    throw new Error("Artifact concept deprecated. Use project listeners to store artifacts after goals.");
}

function updateBuildStatus(status: "started" | "failed" | "error" | "passed" | "canceled",
                           sdmGoal: SdmGoalEvent,
                           url: string,
                           buildNo: string,
                           team: string): Promise<any> {
    const data = {
        repository: {
            owner_name: sdmGoal.repo.owner,
            name: sdmGoal.repo.name,
        },
        name: `Build #${buildNo}`,
        number: +buildNo,
        type: "push",
        build_url: url,
        status,
        commit: sdmGoal.sha,
        branch: sdmGoal.branch,
        provider: "sdm",
        started_at: status === "started" ? new Date().toISOString() : undefined,
        finished_at: status !== "started" ? new Date().toISOString() : undefined,
    };
    return postWebhook("build", data, team);
}
