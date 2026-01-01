/**
 * SQLite Schema for Source Chain Storage
 *
 * This schema mirrors the IndexedDB structure from source-chain-storage.ts
 * but uses SQLite with OPFS persistence for synchronous durable writes.
 *
 * Key Design Decisions:
 * - BLOB types for hashes (stored as raw bytes)
 * - TEXT for cellId (composite key as "dnaHash:agentPubKey" in base64)
 * - TEXT for timestamps (stored as string representation of bigint)
 * - INTEGER for sequence numbers and type indices
 */

/**
 * SQL statements to create the schema
 */
export const SCHEMA_SQL = `
-- Actions table (source chain actions)
-- Stores all action types with nullable fields for type-specific data
CREATE TABLE IF NOT EXISTS actions (
  action_hash BLOB PRIMARY KEY,
  cell_id TEXT NOT NULL,
  action_seq INTEGER NOT NULL,
  author BLOB NOT NULL,
  timestamp TEXT NOT NULL,
  prev_action_hash BLOB,
  action_type TEXT NOT NULL,
  signature BLOB NOT NULL,

  -- Entry fields (Create, Update)
  entry_hash BLOB,
  entry_type TEXT,

  -- Update fields
  original_action_hash BLOB,
  original_entry_hash BLOB,

  -- Delete fields
  deletes_action_hash BLOB,
  deletes_entry_hash BLOB,

  -- CreateLink fields
  base_address BLOB,
  target_address BLOB,
  zome_index INTEGER,
  link_type INTEGER,
  tag BLOB,

  -- DeleteLink fields
  link_add_address BLOB,

  -- Dna action fields
  dna_hash BLOB,

  -- AgentValidationPkg fields
  membrane_proof BLOB
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_actions_cell_seq ON actions(cell_id, action_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_cell_seq_unique ON actions(cell_id, action_seq);
CREATE INDEX IF NOT EXISTS idx_actions_cell ON actions(cell_id);
CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(action_type);
CREATE INDEX IF NOT EXISTS idx_actions_entry_hash ON actions(entry_hash);

-- Entries table (entry content)
CREATE TABLE IF NOT EXISTS entries (
  entry_hash BLOB PRIMARY KEY,
  cell_id TEXT NOT NULL,
  entry_content BLOB NOT NULL,
  entry_type TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_cell ON entries(cell_id);

-- Links table
CREATE TABLE IF NOT EXISTS links (
  create_link_hash BLOB PRIMARY KEY,
  cell_id TEXT NOT NULL,
  base_address BLOB NOT NULL,
  target_address BLOB NOT NULL,
  timestamp TEXT NOT NULL,
  zome_index INTEGER NOT NULL,
  link_type INTEGER NOT NULL,
  tag BLOB NOT NULL,
  author BLOB NOT NULL,
  deleted INTEGER DEFAULT 0,
  delete_hash BLOB
);

CREATE INDEX IF NOT EXISTS idx_links_cell_base ON links(cell_id, base_address);
CREATE INDEX IF NOT EXISTS idx_links_cell_base_type ON links(cell_id, base_address, link_type);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_address);

-- Chain heads table (one per cell)
CREATE TABLE IF NOT EXISTS chain_heads (
  cell_id TEXT PRIMARY KEY,
  action_seq INTEGER NOT NULL,
  action_hash BLOB NOT NULL,
  timestamp TEXT NOT NULL
);
`;

/**
 * Prepared statement templates for common operations
 */
export const STATEMENTS = {
  // Chain head operations
  GET_CHAIN_HEAD: 'SELECT * FROM chain_heads WHERE cell_id = ?',
  SET_CHAIN_HEAD: `
    INSERT INTO chain_heads (cell_id, action_seq, action_hash, timestamp)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cell_id) DO UPDATE SET
      action_seq = excluded.action_seq,
      action_hash = excluded.action_hash,
      timestamp = excluded.timestamp
  `,

  // Action operations
  INSERT_ACTION: `
    INSERT INTO actions (
      action_hash, cell_id, action_seq, author, timestamp, prev_action_hash,
      action_type, signature, entry_hash, entry_type, original_action_hash,
      original_entry_hash, deletes_action_hash, deletes_entry_hash,
      base_address, target_address, zome_index, link_type, tag,
      link_add_address, dna_hash, membrane_proof
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  GET_ACTION: 'SELECT * FROM actions WHERE action_hash = ?',
  GET_ACTIONS_BY_CELL: 'SELECT * FROM actions WHERE cell_id = ? ORDER BY action_seq',
  GET_ACTIONS_BY_CELL_TYPE: 'SELECT * FROM actions WHERE cell_id = ? AND action_type = ? ORDER BY action_seq',
  GET_ACTIONS_BY_ENTRY_HASH: 'SELECT * FROM actions WHERE entry_hash = ?',

  // Entry operations
  INSERT_ENTRY: `
    INSERT OR REPLACE INTO entries (entry_hash, cell_id, entry_content, entry_type)
    VALUES (?, ?, ?, ?)
  `,
  GET_ENTRY: 'SELECT * FROM entries WHERE entry_hash = ?',
  GET_ENTRIES_BY_CELL: 'SELECT * FROM entries WHERE cell_id = ?',

  // Link operations
  INSERT_LINK: `
    INSERT OR REPLACE INTO links (
      create_link_hash, cell_id, base_address, target_address, timestamp,
      zome_index, link_type, tag, author, deleted, delete_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  GET_LINKS_BY_BASE: 'SELECT * FROM links WHERE cell_id = ? AND base_address = ?',
  GET_LINKS_BY_BASE_TYPE: 'SELECT * FROM links WHERE cell_id = ? AND base_address = ? AND link_type = ?',
  GET_ALL_LINKS_BY_CELL: 'SELECT * FROM links WHERE cell_id = ?',
  DELETE_LINK: 'UPDATE links SET deleted = 1, delete_hash = ? WHERE create_link_hash = ?',

  // Utility operations
  CLEAR_ACTIONS: 'DELETE FROM actions',
  CLEAR_ENTRIES: 'DELETE FROM entries',
  CLEAR_LINKS: 'DELETE FROM links',
  CLEAR_CHAIN_HEADS: 'DELETE FROM chain_heads',
} as const;

/**
 * Message types for worker communication
 */
export type WorkerMessageType =
  | 'INIT'
  | 'QUERY'
  | 'EXEC'
  | 'BEGIN'
  | 'COMMIT'
  | 'ROLLBACK'
  | 'CLOSE';

export interface WorkerRequest {
  id: number;
  type: WorkerMessageType;
  payload?: {
    sql?: string;
    params?: unknown[];
  };
}

export interface WorkerResponse {
  id: number;
  success: boolean;
  result?: unknown;
  error?: string;
}
