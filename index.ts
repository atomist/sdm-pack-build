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

export {
    Build,
    BuilderRegistration,
} from "./lib/Build";
export {
    Builder,
    BuildInProgress,
    executeBuild,
} from "./lib/support/build/executeBuild";
export {
    SpawnBuilderOptions,
    spawnBuilder,
} from "./lib/support/build/spawnBuilder";
export { buildAwareCodeTransforms } from "./lib/buildAwareTransform";
export {
    makeBuildAware,
    BuildAwareMarker,
} from "./lib/support/build-aware/makeBuildAware";
