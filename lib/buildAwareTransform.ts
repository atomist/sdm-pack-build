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

import {metadata} from "@atomist/sdm/lib/api-helper/misc/extensionPack";
import {GitHubIssueRouter} from "@atomist/sdm/lib/api-helper/misc/git/GitHubIssueRouter";
import {ExtensionPack} from "@atomist/sdm/lib/api/machine/ExtensionPack";
import {IssueCreationOptions} from "@atomist/sdm/lib/spi/issue/IssueCreationOptions";
import { Build } from "./Build";
import { buildAwareBuildListener } from "./support/build-aware/buildAwareBuildListener";

export interface BuildAwareTransformOptions {
    buildGoal: Build | Build[];
    issueCreation: Partial<IssueCreationOptions>;
}

/**
 * Extension pack to add "build aware" code transform support, where
 * a branch is quietly created in the first instance,
 * and an issue or PR is created in response to build status.
 * It's necessary to add this pack
 * to have dry run editorCommand function respond to builds.
 */
export function buildAwareCodeTransforms(options: BuildAwareTransformOptions): ExtensionPack {
    const optsToUse: IssueCreationOptions = {
        issueRouter: new GitHubIssueRouter(),
        ...(options.issueCreation || {}),
}
    ;

    return {
        ...metadata("build-aware-code-transforms"),
        configure: sdm => {
            if (!!options.buildGoal) {
                const buildGoals = Array.isArray(options.buildGoal) ? options.buildGoal : [options.buildGoal];
                buildGoals.forEach(bg => bg.withListener(buildAwareBuildListener(optsToUse)));
            }
        },
    };
}
