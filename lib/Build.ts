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
    DefaultGoalNameGenerator,
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrations,
    getGoalDefinitionFrom,
    Goal,
    ImplementationRegistration,
    IndependentOfEnvironment,
} from "@atomist/sdm";
import {
    Builder,
    executeBuild,
} from "./support/build/executeBuild";

/**
 * Register a Builder for a certain type of push
 */
export interface BuilderRegistration extends Partial<ImplementationRegistration> {
    builder: Builder;
}

/**
 * Goal that performs builds: For example using a Maven or NPM Builder implementation
 */
export class Build extends FulfillableGoalWithRegistrations<BuilderRegistration> {

    constructor(goalDetailsOrUniqueName: FulfillableGoalDetails | string
                    = DefaultGoalNameGenerator.generateName("build"),
                ...dependsOn: Goal[]) {

        super({
            ...BuildGoal.definition,
            ...getGoalDefinitionFrom(goalDetailsOrUniqueName, DefaultGoalNameGenerator.generateName("build")),
            displayName: "build",
        }, ...dependsOn);
    }

    public with(registration: BuilderRegistration): this {
        this.addFulfillment({
            name: DefaultGoalNameGenerator.generateName("builder"),
            goalExecutor: executeBuild(registration.builder),
            ...registration as ImplementationRegistration,
        });
        return this;
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