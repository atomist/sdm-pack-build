import {
    HandlerContext,
    QueryNoCacheOptions,
} from "@atomist/automation-client";
import {
    descriptionFromState,
    ExecuteGoal,
    Goal,
    GoalInvocation,
    SdmGoalEvent,
    updateGoal,
} from "@atomist/sdm";
import {
    BuildForCommit,
    BuildStatus,
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

        if (!!builds && !!builds.Build && builds.Build.length > 0) {
            const build = builds.Build[0];
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
