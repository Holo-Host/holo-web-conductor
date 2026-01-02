/**
 * SQLite Storage Tests
 *
 * Tests the SQLite schema and operations using sql.js (in-memory).
 * This validates the SQL statements work correctly before browser integration.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { SCHEMA_SQL, STATEMENTS } from './sqlite-schema';

// Helper to convert Uint8Array to number[] for sql.js binding
function hashToBlob(hash: Uint8Array): number[] {
  return Array.from(hash);
}

// Helper to convert blob back to Uint8Array
function blobToHash(blob: number[] | Uint8Array | null): Uint8Array | null {
  if (blob === null) return null;
  return new Uint8Array(blob);
}

describe('SQLite Schema and Operations', () => {
  let db: Database;

  beforeAll(async () => {
    // Initialize sql.js
    const SQL = await initSqlJs();
    db = new SQL.Database();
  });

  beforeEach(() => {
    // Clear and recreate tables before each test
    db.run('DROP TABLE IF EXISTS actions');
    db.run('DROP TABLE IF EXISTS entries');
    db.run('DROP TABLE IF EXISTS links');
    db.run('DROP TABLE IF EXISTS chain_heads');

    // Create schema
    db.run(SCHEMA_SQL);
  });

  describe('Schema Creation', () => {
    it('should create all tables', () => {
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
      const tableNames = tables[0].values.map(row => row[0]);

      expect(tableNames).toContain('actions');
      expect(tableNames).toContain('entries');
      expect(tableNames).toContain('links');
      expect(tableNames).toContain('chain_heads');
    });

    it('should create indexes', () => {
      const indexes = db.exec("SELECT name FROM sqlite_master WHERE type='index'");
      const indexNames = indexes[0].values.map(row => row[0]);

      expect(indexNames).toContain('idx_actions_cell_seq');
      expect(indexNames).toContain('idx_actions_cell');
      expect(indexNames).toContain('idx_entries_cell');
      expect(indexNames).toContain('idx_links_cell_base');
    });
  });

  describe('Chain Head Operations', () => {
    const cellId = 'test-cell-id';
    const actionHash = new Uint8Array([1, 2, 3, 4, 5]);
    const timestamp = '1234567890';

    it('should insert and get chain head', () => {
      // Insert
      db.run(STATEMENTS.SET_CHAIN_HEAD, [cellId, 0, hashToBlob(actionHash), timestamp]);

      // Get
      const result = db.exec(STATEMENTS.GET_CHAIN_HEAD, [cellId]);
      expect(result.length).toBe(1);
      expect(result[0].values.length).toBe(1);

      const row = result[0].values[0];
      expect(row[0]).toBe(cellId); // cell_id
      expect(row[1]).toBe(0); // action_seq
      expect(blobToHash(row[2] as Uint8Array)).toEqual(actionHash); // action_hash
      expect(row[3]).toBe(timestamp); // timestamp
    });

    it('should update chain head on conflict', () => {
      const newActionHash = new Uint8Array([6, 7, 8, 9, 10]);
      const newTimestamp = '9876543210';

      // Insert first
      db.run(STATEMENTS.SET_CHAIN_HEAD, [cellId, 0, hashToBlob(actionHash), timestamp]);

      // Update (same cellId, different values)
      db.run(STATEMENTS.SET_CHAIN_HEAD, [cellId, 5, hashToBlob(newActionHash), newTimestamp]);

      // Get updated
      const result = db.exec(STATEMENTS.GET_CHAIN_HEAD, [cellId]);
      const row = result[0].values[0];

      expect(row[1]).toBe(5); // action_seq updated
      expect(blobToHash(row[2] as Uint8Array)).toEqual(newActionHash);
      expect(row[3]).toBe(newTimestamp);
    });
  });

  describe('Action Operations', () => {
    const cellId = 'test-cell-id';
    const actionHash = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const author = new Uint8Array([10, 20, 30, 40]);
    const signature = new Uint8Array([50, 60, 70, 80]);
    const entryHash = new Uint8Array([100, 110, 120, 130]);

    it('should insert and get a Create action', () => {
      const params = [
        hashToBlob(actionHash), // action_hash
        cellId, // cell_id
        1, // action_seq
        hashToBlob(author), // author
        '1234567890', // timestamp
        null, // prev_action_hash
        'Create', // action_type
        hashToBlob(signature), // signature
        hashToBlob(entryHash), // entry_hash
        'App(0,0)', // entry_type
        null, // original_action_hash
        null, // original_entry_hash
        null, // deletes_action_hash
        null, // deletes_entry_hash
        null, // base_address
        null, // target_address
        null, // zome_index
        null, // link_type
        null, // tag
        null, // link_add_address
        null, // dna_hash
        null, // membrane_proof
      ];

      db.run(STATEMENTS.INSERT_ACTION, params);

      // Get by hash
      const result = db.exec(STATEMENTS.GET_ACTION, [hashToBlob(actionHash)]);
      expect(result.length).toBe(1);

      const row = result[0].values[0];
      expect(blobToHash(row[0] as Uint8Array)).toEqual(actionHash);
      expect(row[6]).toBe('Create'); // action_type column
    });

    it('should query actions by cell ID', () => {
      // Insert multiple actions
      for (let i = 0; i < 3; i++) {
        const hash = new Uint8Array([1, 2, 3, 4, 5, 6, 7, i]);
        const params = [
          hashToBlob(hash),
          cellId,
          i,
          hashToBlob(author),
          '1234567890',
          null,
          'Create',
          hashToBlob(signature),
          hashToBlob(entryHash),
          'App(0,0)',
          null, null, null, null, null, null, null, null, null, null, null, null,
        ];
        db.run(STATEMENTS.INSERT_ACTION, params);
      }

      const result = db.exec(STATEMENTS.GET_ACTIONS_BY_CELL, [cellId]);
      expect(result[0].values.length).toBe(3);
    });

    it('should query actions by entry hash', () => {
      const params = [
        hashToBlob(actionHash),
        cellId,
        1,
        hashToBlob(author),
        '1234567890',
        null,
        'Create',
        hashToBlob(signature),
        hashToBlob(entryHash),
        'App(0,0)',
        null, null, null, null, null, null, null, null, null, null, null, null,
      ];
      db.run(STATEMENTS.INSERT_ACTION, params);

      const result = db.exec(STATEMENTS.GET_ACTIONS_BY_ENTRY_HASH, [hashToBlob(entryHash)]);
      expect(result.length).toBe(1);
      expect(result[0].values.length).toBe(1);
    });
  });

  describe('Entry Operations', () => {
    const cellId = 'test-cell-id';
    const entryHash = new Uint8Array([1, 2, 3, 4, 5]);
    const entryContent = new Uint8Array([10, 20, 30, 40, 50, 60]);

    it('should insert and get an entry', () => {
      db.run(STATEMENTS.INSERT_ENTRY, [
        hashToBlob(entryHash),
        cellId,
        hashToBlob(entryContent),
        'App(0,0)',
      ]);

      const result = db.exec(STATEMENTS.GET_ENTRY, [hashToBlob(entryHash)]);
      expect(result.length).toBe(1);

      const row = result[0].values[0];
      expect(blobToHash(row[0] as Uint8Array)).toEqual(entryHash);
      expect(blobToHash(row[2] as Uint8Array)).toEqual(entryContent);
      expect(row[3]).toBe('App(0,0)');
    });

    it('should replace entry on duplicate hash', () => {
      const newContent = new Uint8Array([99, 88, 77]);

      db.run(STATEMENTS.INSERT_ENTRY, [
        hashToBlob(entryHash),
        cellId,
        hashToBlob(entryContent),
        'App(0,0)',
      ]);

      db.run(STATEMENTS.INSERT_ENTRY, [
        hashToBlob(entryHash),
        cellId,
        hashToBlob(newContent),
        'App(0,1)',
      ]);

      const result = db.exec(STATEMENTS.GET_ENTRY, [hashToBlob(entryHash)]);
      const row = result[0].values[0];
      expect(blobToHash(row[2] as Uint8Array)).toEqual(newContent);
    });
  });

  describe('Link Operations', () => {
    const cellId = 'test-cell-id';
    const createLinkHash = new Uint8Array([1, 2, 3, 4, 5]);
    const baseAddress = new Uint8Array([10, 20, 30]);
    const targetAddress = new Uint8Array([40, 50, 60]);
    const author = new Uint8Array([70, 80, 90]);
    const tag = new Uint8Array([100, 110]);

    it('should insert and get links by base', () => {
      db.run(STATEMENTS.INSERT_LINK, [
        hashToBlob(createLinkHash),
        cellId,
        hashToBlob(baseAddress),
        hashToBlob(targetAddress),
        '1234567890',
        0, // zome_index
        1, // link_type
        hashToBlob(tag),
        hashToBlob(author),
        0, // deleted
        null, // delete_hash
      ]);

      const result = db.exec(STATEMENTS.GET_LINKS_BY_BASE, [cellId, hashToBlob(baseAddress)]);
      expect(result.length).toBe(1);
      expect(result[0].values.length).toBe(1);
    });

    it('should get links by base and type', () => {
      // Insert two links with different types
      for (let type = 0; type < 2; type++) {
        const hash = new Uint8Array([1, 2, 3, 4, type]);
        db.run(STATEMENTS.INSERT_LINK, [
          hashToBlob(hash),
          cellId,
          hashToBlob(baseAddress),
          hashToBlob(targetAddress),
          '1234567890',
          0,
          type,
          hashToBlob(tag),
          hashToBlob(author),
          0,
          null,
        ]);
      }

      const result = db.exec(STATEMENTS.GET_LINKS_BY_BASE_TYPE, [cellId, hashToBlob(baseAddress), 1]);
      expect(result[0].values.length).toBe(1);
    });

    it('should mark link as deleted', () => {
      db.run(STATEMENTS.INSERT_LINK, [
        hashToBlob(createLinkHash),
        cellId,
        hashToBlob(baseAddress),
        hashToBlob(targetAddress),
        '1234567890',
        0,
        1,
        hashToBlob(tag),
        hashToBlob(author),
        0,
        null,
      ]);

      const deleteHash = new Uint8Array([200, 201, 202]);
      db.run(STATEMENTS.DELETE_LINK, [hashToBlob(deleteHash), hashToBlob(createLinkHash)]);

      const result = db.exec('SELECT deleted, delete_hash FROM links WHERE create_link_hash = ?', [hashToBlob(createLinkHash)]);
      expect(result[0].values[0][0]).toBe(1); // deleted = true
      expect(blobToHash(result[0].values[0][1] as Uint8Array)).toEqual(deleteHash);
    });
  });

  describe('Transaction Support', () => {
    it('should rollback transaction on failure', () => {
      const cellId = 'test-cell-id';
      const entryHash = new Uint8Array([1, 2, 3]);
      const entryContent = new Uint8Array([10, 20, 30]);

      db.run('BEGIN TRANSACTION');
      db.run(STATEMENTS.INSERT_ENTRY, [
        hashToBlob(entryHash),
        cellId,
        hashToBlob(entryContent),
        'App(0,0)',
      ]);
      db.run('ROLLBACK');

      const result = db.exec(STATEMENTS.GET_ENTRY, [hashToBlob(entryHash)]);
      expect(result.length).toBe(0); // Entry should not exist
    });

    it('should commit transaction', () => {
      const cellId = 'test-cell-id';
      const entryHash = new Uint8Array([1, 2, 3]);
      const entryContent = new Uint8Array([10, 20, 30]);

      db.run('BEGIN TRANSACTION');
      db.run(STATEMENTS.INSERT_ENTRY, [
        hashToBlob(entryHash),
        cellId,
        hashToBlob(entryContent),
        'App(0,0)',
      ]);
      db.run('COMMIT');

      const result = db.exec(STATEMENTS.GET_ENTRY, [hashToBlob(entryHash)]);
      expect(result.length).toBe(1);
    });
  });

  describe('Clear Operations', () => {
    it('should clear all tables', () => {
      // Insert data in each table
      const cellId = 'test-cell-id';

      db.run(STATEMENTS.SET_CHAIN_HEAD, [cellId, 0, [1, 2, 3], '123']);
      db.run(STATEMENTS.INSERT_ENTRY, [[1], cellId, [1, 2, 3], 'App(0,0)']);
      db.run(STATEMENTS.INSERT_LINK, [[1], cellId, [1], [2], '123', 0, 0, [1], [1], 0, null]);

      // Clear
      db.run(STATEMENTS.CLEAR_ACTIONS);
      db.run(STATEMENTS.CLEAR_ENTRIES);
      db.run(STATEMENTS.CLEAR_LINKS);
      db.run(STATEMENTS.CLEAR_CHAIN_HEADS);

      // Verify empty
      expect(db.exec('SELECT COUNT(*) FROM actions')[0].values[0][0]).toBe(0);
      expect(db.exec('SELECT COUNT(*) FROM entries')[0].values[0][0]).toBe(0);
      expect(db.exec('SELECT COUNT(*) FROM links')[0].values[0][0]).toBe(0);
      expect(db.exec('SELECT COUNT(*) FROM chain_heads')[0].values[0][0]).toBe(0);
    });
  });
});
