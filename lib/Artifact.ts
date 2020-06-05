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
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrations, getGoalDefinitionFrom
} from "@atomist/sdm/lib/api/goal/GoalWithFulfillment";
import {SoftwareDeliveryMachine} from "@atomist/sdm/lib/api/machine/SoftwareDeliveryMachine";
import {DefaultGoalNameGenerator} from "@atomist/sdm/lib/api/goal/GoalNameGenerator";
import {Goal} from "@atomist/sdm/lib/api/goal/Goal";
import {IndependentOfEnvironment} from "@atomist/sdm/lib/api/goal/support/environment";

/**
 * @deprecated Artifact concept deprecated. Use project listeners to store artifacts after goals.
 */
export interface ArtifactRegistration {
    listeners?: never;
        // ArtifactListenerRegisterable[];
}

/**
 * This goal is fulfilled by an OnImageLinked event subscription. The Build goal will
 * cause such an event to be emitted, but external CI systems can trigger the goal
 * fulfillment as well. On fulfillment, the external URL for the artifact will be
 * put on the goal instance and shown in the client.
 *
 * You can register listeners on this event to trigger when a new artifact is available
 * through this goal.
 *
 * @deprecated Artifact concept deprecated. Use project listeners to store artifacts after goals.
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

        throw new Error("Artifact deprecated. Use TODO instead");
    }

    public register(sdm: SoftwareDeliveryMachine): void {
        super.register(sdm);
        throw new Error("Artifact deprecated. Use TODO instead");
    }
}

/**
 * @deprecated Artifact concept deprecated. Use project listeners to store artifacts after goals.
 */
const ArtifactGoal = new Goal({
    uniqueName: "artifact",
    environment: IndependentOfEnvironment,
    displayName: "store artifact",
    completedDescription: "Stored artifact",
});
