export { findSuiteDefinition, registeredRuntimeDefinitions, suiteDefinitions } from "./definitions"
export type {
  DockerOwnership,
  E2eScope,
  E2eScopeSelection,
  RequiredTool,
  SuiteDefinition,
  SuiteTag
} from "./definitions"
export { runDefinition, runE2e, runE2eRequest, runSuite } from "./executor"
export {
  dockerInventoryCommands,
  dockerRemovalCommands,
  newDockerOwner,
  verifyDockerOwnerCleanup
} from "./harness/docker-owner"
export type { DockerSnapshot } from "./harness/docker-owner"
export {
  createProcessSupervisor,
  decodePosixControllerFrame,
  encodePosixControllerFrame,
  runCheckedCommand,
  runCommand
} from "./harness/process"
export type {
  CommandDefinition,
  CommandResult,
  ContainmentClaim,
  ProcessMode,
  ProcessPreflightResult,
  ProcessStrategy,
  ProcessSupervisor,
  ProcessTermination,
  PosixControllerFrame,
  ResidualObservation
} from "./harness/process"
export { E2eUsage, parseE2eArguments, selectedSuites, selectExecutionPlan } from "./selection"
export type { E2eRequest } from "./selection"
