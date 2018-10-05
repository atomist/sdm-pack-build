import {
    ArtifactGoal,
    DefaultGoalNameGenerator,
    FulfillableGoal,
    FulfillableGoalDetails,
    getGoalDefinitionFrom,
    Goal,
} from "@atomist/sdm";

export class Artifact extends FulfillableGoal {
    constructor(goalDetailsOrUniqueName: FulfillableGoalDetails | string
                    = DefaultGoalNameGenerator.generateName("artifact"),
                ...dependsOn: Goal[]) {

        super({
            ...ArtifactGoal.definition,
            ...getGoalDefinitionFrom(goalDetailsOrUniqueName, DefaultGoalNameGenerator.generateName("artifact")),
            displayName: "artifact",
        }, ...dependsOn);
    }
}


