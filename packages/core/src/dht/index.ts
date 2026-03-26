/**
 * DHT Module
 *
 * Provides types and utilities for DHT operations in the browser extension.
 * This includes generating DhtOps from source chain records for publishing.
 */

// Types
export {
  // OpBasis type
  type OpBasis,

  // ChainOpType enum
  ChainOpType,

  // RecordEntry helpers
  type RecordEntry,
  recordEntryPresent,
  recordEntryNA,
  recordEntryHidden,
  isRecordEntryPresent,
  getRecordEntry,

  // ChainOp types
  type ChainOp,
  type StoreRecordOp,
  type StoreEntryOp,
  type RegisterAgentActivityOp,
  type RegisterUpdatedContentOp,
  type RegisterUpdatedRecordOp,
  type RegisterDeletedByOp,
  type RegisterDeletedEntryActionOp,
  type RegisterAddLinkOp,
  type RegisterRemoveLinkOp,

  // ChainOpLite type
  type ChainOpLite,

  // Action to op types mapping
  actionToOpTypes,

  // Type guards
  isCreateAction,
  isUpdateAction,
  isDeleteAction,
  isCreateLinkAction,
  isDeleteLinkAction,
  isNewEntryAction,

  // Publish tracking
  PublishStatus,
  type PendingPublish,
} from "./dht-op-types";

// Op production functions
export {
  produceOpsFromRecord,
  produceOpLitesFromRecord,
  computeOpBasis,
  getOpAction,
  getOpSignature,
} from "./produce-ops";

// Publish tracking
export { PublishTracker, type PublishAttemptResult } from "./publish-tracker";

// Publish service
export { PublishService, type PublishServiceOptions } from "./publish-service";

// Publish retry on reconnect
export { retryPublishesAfterReconnect } from "./publish-retry";

// Record conversion utilities
export {
  storedActionToClientAction,
  storedEntryToClientEntry,
  storedEntryToRecordEntry,
  buildRecord,
  buildRecords,
  buildSignedActionHashedArray,
} from "./record-converter";

// Op serialization for linker
export {
  convertOpToRustFormat,
  stripTypeField,
  convertToExternallyTagged,
  serializeOpForLinker,
} from "./op-serialization";

// Validation types
export {
  type ValidateCallbackResult,
  type UnresolvedDependencies,
  type ChainFilter,
  type ChainFilters,
} from "./validate-types";

// Validation Op types and construction
export {
  type Op,
  type SignedHashed,
  type EntryCreationAction,
  type StoreRecordData,
  type StoreEntryData,
  type RegisterUpdateData,
  type RegisterDeleteData,
  type RegisterAgentActivityData,
  type RegisterCreateLinkData,
  type RegisterDeleteLinkData,
  type CreateLinkResolver,
  buildOpFromRecord,
  recordToOps,
  pendingRecordToOps,
  getOpVariant,
} from "./validation-op";
