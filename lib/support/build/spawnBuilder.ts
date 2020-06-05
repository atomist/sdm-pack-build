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

import {GitProject} from "@atomist/automation-client/lib/project/git/GitProject";
import {Project} from "@atomist/automation-client/lib/project/Project";
import {logger} from "@atomist/automation-client/lib/util/logger";
import {ErrorFinder, spawnLog, SpawnLogOptions, SpawnLogResult} from "@atomist/sdm/lib/api-helper/misc/child_process";
import {serializeResult} from "@atomist/sdm/lib/api-helper/misc/result";
import {InterpretLog} from "@atomist/sdm/lib/spi/log/InterpretedLog";
import { SpawnOptions } from "child_process";
import * as _ from "lodash";
import { AppInfo } from "./AppInfo";
import {
    Builder,
    BuildInProgress,
} from "./executeBuild";

export interface SpawnBuilderOptions {

    name: string;

    /**
     * Commands we'll execute via Node spawn.
     * Command execution will terminate on the first error.
     */
    commands?: Array<{command: string, args?: string[], options?: SpawnLogOptions}>;

    /**
     * Alternative to commands. File containing a list of
     * newline-separated commands. May contain blank lines
     * or comments beginning with #.
     */
    commandFile?: string;

    /**
     * Error finder: Necessary only if a spawned process
     * can return non-zero on success.
     */
    errorFinder?: ErrorFinder;

    /**
     * Interpreter of command output
     */
    logInterpreter: InterpretLog;

    options?: SpawnOptions;

    /**
     * If this method is implemented, it enriches the options returned by the options
     * property with data from within the given project
     * @param {GitProject} p
     * @param {module:child_process.SpawnOptions} options
     * @return {Promise<module:child_process.SpawnOptions>}
     */
    enrich?(options: SpawnOptions, p: GitProject): Promise<SpawnOptions>;

    /**
     * Find artifact info from the sources of this project,
     * for example by parsing a package.json or Maven POM file.
     * @param {Project} p
     * @return {Promise<AppInfo>}
     */
    projectToAppInfo(p: Project): Promise<AppInfo>;

    /**
     * Find the deploymentUnit after a successful build
     * @param {Project} p
     * @param {AppInfo} appId
     * @return {Promise<string>}
     *
     * @deprecated Artifact concept deprecated. Use project listeners to store artifacts after goals.
     */
    deploymentUnitFor?(p: GitProject, appId: AppInfo): Promise<string>;

}

export function spawnBuilder(options: SpawnBuilderOptions): Builder {
    if (!options.commands && !options.commandFile) {
        throw new Error("Please supply either commands or a path to a file in the project containing them");
    }
    return async goalInvocation => {
        const { configuration, id, progressLog } = goalInvocation;
        const errorFinder = options.errorFinder;

        logger.info("Starting build on %s/%s, buildCommands '%j' or file '%s'", id.owner, id.repo, options.commands,
            options.commandFile);

        return configuration.sdm.projectLoader.doWithProject({
                ...goalInvocation,
                readOnly: false, // a build command is likely going to make changes
                cloneOptions: { detachHead: true },
            },
            async p => {
                const commands: Array<{command: string, args?: string[], options?: SpawnLogOptions}> =
                    options.commands || await loadCommandsFromFile(p, options.commandFile);

                const appId: AppInfo = await options.projectToAppInfo(p);

                let optionsToUse = options.options || {};
                if (!!options.enrich) {
                    logger.info("Enriching options from project %s/%s", p.id.owner, p.id.repo);
                    optionsToUse = await options.enrich(optionsToUse, p);
                }
                const opts = _.merge({ cwd: p.baseDir, log: progressLog,
                    errorFinder }, optionsToUse);

                function executeOne(buildCommand: { command: string,
                                                    args?: string[],
                                                    options?: SpawnLogOptions}): Promise<SpawnLogResult> {
                    return spawnLog(buildCommand.command,
                        buildCommand.args,
                        _.merge(opts, buildCommand.options));
                }

                let buildResult;
                for (const buildCommand of commands) {
                    buildResult = await executeOne(buildCommand);
                    if (buildResult.error) {
                        throw new Error("Build failure: " + buildResult.error);
                    }
                    progressLog.write("/--");
                    progressLog.write(`Result: ${serializeResult(buildResult)}`);
                    progressLog.write("\\--");
                }
                logger.info("Build RETURN: %j", buildResult);
                return new SpawnedBuild(appId, buildResult,
                    !!options.deploymentUnitFor ? await options.deploymentUnitFor(p, appId) : undefined);
            });

    };
}

async function loadCommandsFromFile(p: Project, path: string):
    Promise<Array<{command: string, args?: string[], options?: SpawnLogOptions}>> {
    const buildFile = await p.getFile(path);
    if (!buildFile) {
        return undefined;
    }
    const content = await buildFile.getContent();
    const commands = content.split("\n")
        .filter(l => !!l)
        .filter(l => !l.startsWith("#"))
        .map(l => ({command: l}));
    logger.info("Found Atomist build file in project %j: Commands are %j", p.id,
        commands);

    return commands;
}

class SpawnedBuild implements BuildInProgress {

    constructor(public appInfo: AppInfo,
                public buildResult: SpawnLogResult,
                public deploymentUnitFile: string) {
    }

}
