/**
 * Core Type Definitions
 *
 * Central export point for all Holochain and bundle types.
 * Import from here for consistent access to types across the codebase.
 */

// Re-export everything from holochain-types
export * from './holochain-types';

// Re-export everything from bundle-types
export * from './bundle-types';

// Re-export serialization types and functions (explicitly to avoid conflicts)
// These are used for signing actions - the serialization MUST match Holochain's format exactly
export {
  // Serialization function
  serializeAction,
  // Serializable action union type
  type SerializableAction,
  type ActionTypeName,
  // Action content types (for building actions)
  type DnaActionContent,
  type AgentValidationPkgActionContent,
  type InitZomesCompleteActionContent,
  type CreateActionContent,
  type UpdateActionContent,
  type DeleteActionContent,
  type CreateLinkActionContent,
  type DeleteLinkActionContent,
  // Rate weight types for serialization
  type EntryRateWeight,
  // Builder functions (ensure correct field ordering)
  buildDnaAction,
  buildAgentValidationPkgAction,
  buildInitZomesCompleteAction,
  buildCreateAction,
  buildUpdateAction,
  buildDeleteAction,
  buildCreateLinkAction,
  buildDeleteLinkAction,
  buildAppEntryType,
} from './holochain-serialization';
