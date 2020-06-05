import {RemoteRepoRef} from "@atomist/automation-client/lib/operations/common/RepoId";

/* Although it's not ideal adding AppInfo here as a cludge, it's easier than refactoring everything. */

/**
 * Info to send up for a deployment
 *
 * @deprecated Artifact concept deprecated. Use project listeners to store artifacts after goals.
 */
export interface AppInfo {
    name: string;
    version: string;
    id: RemoteRepoRef;
}
