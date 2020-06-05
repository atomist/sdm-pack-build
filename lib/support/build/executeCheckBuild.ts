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

import {HandlerContext} from "@atomist/automation-client/lib/HandlerContext";
import {QueryNoCacheOptions} from "@atomist/automation-client/lib/spi/graph/GraphClient";
import {descriptionFromState, updateGoal} from "@atomist/sdm/lib/api-helper/goal/storeGoals";
import {Goal} from "@atomist/sdm/lib/api/goal/Goal";
import {ExecuteGoal, GoalInvocation} from "@atomist/sdm/lib/api/goal/GoalInvocation";
import {SdmGoalEvent} from "@atomist/sdm/lib/api/goal/SdmGoalEvent";
import {BuildStatus} from "@atomist/sdm/lib/typings/types";
import * as _ from "lodash";
import {
    BuildForCommit,
    SdmGoalState,
} from "../../typings/types";

/**
 * Checks if there is already a build on the Commit.
 * If so, sets the goal status according to the build status.
 */
export function executeCheckBuild(): ExecuteGoal {
    return async (goalInvocation: GoalInvocation) => {
        const { goalEvent, context, progressLog } = goalInvocation;

        const builds = await context.graphClient.query<BuildForCommit.Query, BuildForCommit.Variables>({
            name: "BuildForCommit",
            variables: {
                owner: goalEvent.repo.owner,
                repo: goalEvent.repo.name,
                providerId: goalEvent.repo.providerId,
                sha: goalEvent.sha,
            },
            options: QueryNoCacheOptions,
        });

        const build = _.get(builds, "Commit[0].builds[0]");
        if (!!build) {
            progressLog.write(
                `External build ${build.name} from provider ${build.provider} with status ${build.status} received`);
            return {
                externalUrls: [{ label: "Build Log", url: build.buildUrl }],
                state: buildStatusToSdmGoalState(build.status),
            };
        }

        progressLog.write(`Waiting to receive external build event`);

        return {
            state: SdmGoalState.in_process,
        };
    };
}

export async function setBuildContext(ctx: HandlerContext,
                                      goal: Goal,
                                      sdmGoal: SdmGoalEvent,
                                      state: BuildStatus,
                                      url: string): Promise<any> {
    const newState = buildStatusToSdmGoalState(state);
    return updateGoal(ctx, sdmGoal,
        {
            externalUrls: [{ label: "Build Log", url }],
            state: newState,
            description: descriptionFromState(goal, newState),
        });
}

export function buildStatusToSdmGoalState(buildStatus: BuildStatus): SdmGoalState {
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
