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
    ArtifactGoal,
    ArtifactListenerRegisterable,
    DefaultGoalNameGenerator,
    FulfillableGoalDetails,
    FulfillableGoalWithRegistrations,
    getGoalDefinitionFrom,
    Goal,
    SideEffect,
} from "@atomist/sdm";
import { FindArtifactOnImageLinked } from "./support/artifact/FindArtifactOnImageLinked";

export interface ArtifactRegistration {
    listeners: ArtifactListenerRegisterable[];
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
    }


    public with(registration: ArtifactRegistration): this {
        const fulfillment: SideEffect = { name: "build" };
        this.addFulfillment(fulfillment);
        this.sdm.eventHandlers.push(() => new FindArtifactOnImageLinked(
            this,
            registration.listeners,
            this.sdm.configuration.sdm));
        return this;
    }
}

