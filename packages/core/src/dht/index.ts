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

// Record conversion utilities
export {
  storedActionToClientAction,
  storedEntryToClientEntry,
  storedEntryToRecordEntry,
  buildRecord,
  buildRecords,
} from "./record-converter";

// Op serialization for gateway
export {
  convertOpToRustFormat,
  stripTypeField,
  convertToExternallyTagged,
  serializeOpForGateway,
} from "./op-serialization";
