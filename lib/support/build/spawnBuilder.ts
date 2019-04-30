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
    GitProject,
    logger,
    Project,
} from "@atomist/automation-client";
import {
    ErrorFinder,
    InterpretLog,
    serializeResult,
    spawnLog,
    SpawnLogOptions,
    SpawnLogResult,
} from "@atomist/sdm";
import { SpawnOptions } from "child_process";
import * as _ from "lodash";
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
}

export function spawnBuilder(options: SpawnBuilderOptions): Builder {
    if (!options.commands && !options.commandFile) {
        throw new Error("Please supply either commands or a path to a file in the project containing them");
    }
    return async goalInvocation => {
        const { configuration, credentials, id, progressLog } = goalInvocation;
        const errorFinder = options.errorFinder;

        logger.info("Starting build on %s/%s, buildCommands '%j' or file '%s'", id.owner, id.repo, options.commands,
            options.commandFile);

        return configuration.sdm.projectLoader.doWithProject({
                credentials,
                id,
                readOnly: true,
                cloneOptions: { detachHead: true },
            },
            async p => {
                const commands: Array<{command: string, args?: string[], options?: SpawnLogOptions}> =
                    options.commands || await loadCommandsFromFile(p, options.commandFile);

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

                let spawnLogResult: SpawnLogResult;
                for (const buildCommand of commands) {
                    spawnLogResult = await executeOne(buildCommand);
                    if (spawnLogResult.error) {
                        throw new Error("Build failure: " + spawnLogResult.error);
                    }
                    progressLog.write("/--");
                    progressLog.write(`Result: ${serializeResult(spawnLogResult)}`);
                    progressLog.write("\\--");
                }
                logger.info("Build RETURN: %j", spawnLogResult);
                const buildResult: BuildInProgress = { buildResult: spawnLogResult };
                return buildResult ;
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
