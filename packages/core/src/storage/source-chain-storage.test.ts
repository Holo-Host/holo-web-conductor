import { describe, it, expect, beforeEach } from 'vitest';
import { SourceChainStorage } from './source-chain-storage';
import type { CreateAction, Link, UpdateAction, DeleteAction } from './types';

describe('SourceChainStorage', () => {
  let storage: SourceChainStorage;
  const dnaHash = new Uint8Array(32).fill(1);
  const agentPubKey = new Uint8Array(32).fill(2);

  beforeEach(async () => {
    storage = SourceChainStorage.getInstance();
    await storage.init();
    await storage.clear();

    // Ensure no transaction is active from previous test
    if (storage.isTransactionActive()) {
      storage.rollbackTransaction();
    }
  });

  describe('Chain Head Operations', () => {
    it('should return null for uninitialized chain head', async () => {
      const head = await storage.getChainHead(dnaHash, agentPubKey);
      expect(head).toBeNull();
    });

    it('should update and retrieve chain head', async () => {
      const actionHash = new Uint8Array(39).fill(5);
      await storage.updateChainHead(dnaHash, agentPubKey, 3, actionHash, 1000n);

      const head = await storage.getChainHead(dnaHash, agentPubKey);
      expect(head).not.toBeNull();
      expect(head!.actionSeq).toBe(3);
      expect(Array.from(head!.actionHash)).toEqual(Array.from(actionHash));
      expect(head!.timestamp).toBe(1000n);
    });

    it('should update chain head with new sequence', async () => {
      const actionHash1 = new Uint8Array(39).fill(5);
      await storage.updateChainHead(dnaHash, agentPubKey, 3, actionHash1, 1000n);

      const actionHash2 = new Uint8Array(39).fill(6);
      await storage.updateChainHead(dnaHash, agentPubKey, 4, actionHash2, 2000n);

      const head = await storage.getChainHead(dnaHash, agentPubKey);
      expect(head!.actionSeq).toBe(4);
      expect(Array.from(head!.actionHash)).toEqual(Array.from(actionHash2));
      expect(head!.timestamp).toBe(2000n);
    });
  });

  describe('Action Operations', () => {
    it('should store and retrieve a Create action', async () => {
      const action: CreateAction = {
        actionHash: new Uint8Array(39).fill(10),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: new Uint8Array(39).fill(9),
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash: new Uint8Array(39).fill(11),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      await storage.putAction(action, dnaHash, agentPubKey);

      const retrieved = await storage.getAction(action.actionHash);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.actionType).toBe('Create');
      expect(retrieved!.actionSeq).toBe(1);
      expect(Array.from(retrieved!.author)).toEqual(Array.from(agentPubKey));
    });

    it('should query actions by cell ID', async () => {
      const action1: CreateAction = {
        actionHash: new Uint8Array(39).fill(10),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: null,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash: new Uint8Array(39).fill(11),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      const action2: CreateAction = {
        actionHash: new Uint8Array(39).fill(12),
        actionSeq: 2,
        author: agentPubKey,
        timestamp: 6000n,
        prevActionHash: action1.actionHash,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(21),
        entryHash: new Uint8Array(39).fill(13),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      await storage.putAction(action1, dnaHash, agentPubKey);
      await storage.putAction(action2, dnaHash, agentPubKey);

      const actions = await storage.queryActions(dnaHash, agentPubKey);
      expect(actions).toHaveLength(2);
      expect(actions[0].actionSeq).toBe(1);
      expect(actions[1].actionSeq).toBe(2);
    });

    it('should filter actions by type', async () => {
      const createAction: CreateAction = {
        actionHash: new Uint8Array(39).fill(10),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: null,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash: new Uint8Array(39).fill(11),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      const deleteAction: DeleteAction = {
        actionHash: new Uint8Array(39).fill(14),
        actionSeq: 2,
        author: agentPubKey,
        timestamp: 6000n,
        prevActionHash: createAction.actionHash,
        actionType: 'Delete',
        signature: new Uint8Array(64).fill(22),
        deletesActionHash: createAction.actionHash,
        deletesEntryHash: createAction.entryHash,
      };

      await storage.putAction(createAction, dnaHash, agentPubKey);
      await storage.putAction(deleteAction, dnaHash, agentPubKey);

      const creates = await storage.queryActions(dnaHash, agentPubKey, { actionType: 'Create' });
      expect(creates).toHaveLength(1);
      expect(creates[0].actionType).toBe('Create');

      const deletes = await storage.queryActions(dnaHash, agentPubKey, { actionType: 'Delete' });
      expect(deletes).toHaveLength(1);
      expect(deletes[0].actionType).toBe('Delete');
    });
  });

  describe('Entry Operations', () => {
    it('should store and retrieve an entry', async () => {
      const entryHash = new Uint8Array(39).fill(15);
      const entryContent = new Uint8Array([1, 2, 3, 4, 5]);

      await storage.putEntry(
        {
          entryHash,
          entryContent,
          entryType: { zome_id: 0, entry_index: 0 },
        },
        dnaHash,
        agentPubKey
      );

      const retrieved = await storage.getEntry(entryHash);
      expect(retrieved).not.toBeNull();
      expect(Array.from(retrieved!.entryContent)).toEqual(Array.from(entryContent));
    });

    it('should return null for non-existent entry', async () => {
      const entryHash = new Uint8Array(39).fill(99);
      const retrieved = await storage.getEntry(entryHash);
      expect(retrieved).toBeNull();
    });
  });

  describe('Record Operations', () => {
    it('should retrieve a complete record with entry', async () => {
      const actionHash = new Uint8Array(39).fill(10);
      const entryHash = new Uint8Array(39).fill(11);
      const entryContent = new Uint8Array([1, 2, 3]);

      const action: CreateAction = {
        actionHash,
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: null,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash,
        entryType: { zome_id: 0, entry_index: 0 },
      };

      await storage.putAction(action, dnaHash, agentPubKey);
      await storage.putEntry(
        {
          entryHash,
          entryContent,
          entryType: { zome_id: 0, entry_index: 0 },
        },
        dnaHash,
        agentPubKey
      );

      const record = await storage.getRecord(actionHash);
      expect(record).not.toBeNull();
      expect(record!.action.actionType).toBe('Create');
      expect(record!.entry).not.toBeUndefined();
      expect(Array.from(record!.entry!.entryContent)).toEqual(Array.from(entryContent));
    });
  });

  describe('Link Operations', () => {
    it('should store and retrieve links', async () => {
      const link: Link = {
        createLinkHash: new Uint8Array(39).fill(30),
        baseAddress: new Uint8Array(39).fill(31),
        targetAddress: new Uint8Array(39).fill(32),
        timestamp: 7000n,
        zomeIndex: 0,
        linkType: 0,
        tag: new Uint8Array([1, 2, 3]),
        author: agentPubKey,
        deleted: false,
      };

      await storage.putLink(link, dnaHash, agentPubKey);

      const links = await storage.getLinks(link.baseAddress, dnaHash, agentPubKey);
      expect(links).toHaveLength(1);
      expect(Array.from(links[0].targetAddress)).toEqual(Array.from(link.targetAddress));
      expect(links[0].deleted).toBe(false);
    });

    it('should filter links by type', async () => {
      const baseAddress = new Uint8Array(39).fill(31);

      const link1: Link = {
        createLinkHash: new Uint8Array(39).fill(30),
        baseAddress,
        targetAddress: new Uint8Array(39).fill(32),
        timestamp: 7000n,
        zomeIndex: 0,
        linkType: 0,
        tag: new Uint8Array([1, 2, 3]),
        author: agentPubKey,
        deleted: false,
      };

      const link2: Link = {
        createLinkHash: new Uint8Array(39).fill(33),
        baseAddress,
        targetAddress: new Uint8Array(39).fill(34),
        timestamp: 8000n,
        zomeIndex: 0,
        linkType: 1,
        tag: new Uint8Array([4, 5, 6]),
        author: agentPubKey,
        deleted: false,
      };

      await storage.putLink(link1, dnaHash, agentPubKey);
      await storage.putLink(link2, dnaHash, agentPubKey);

      const type0Links = await storage.getLinks(baseAddress, dnaHash, agentPubKey, 0);
      expect(type0Links).toHaveLength(1);
      expect(type0Links[0].linkType).toBe(0);

      const type1Links = await storage.getLinks(baseAddress, dnaHash, agentPubKey, 1);
      expect(type1Links).toHaveLength(1);
      expect(type1Links[0].linkType).toBe(1);

      const allLinks = await storage.getLinks(baseAddress, dnaHash, agentPubKey);
      expect(allLinks).toHaveLength(2);
    });

    it('should mark link as deleted', async () => {
      const link: Link = {
        createLinkHash: new Uint8Array(39).fill(30),
        baseAddress: new Uint8Array(39).fill(31),
        targetAddress: new Uint8Array(39).fill(32),
        timestamp: 7000n,
        zomeIndex: 0,
        linkType: 0,
        tag: new Uint8Array([1, 2, 3]),
        author: agentPubKey,
        deleted: false,
      };

      await storage.putLink(link, dnaHash, agentPubKey);

      const deleteHash = new Uint8Array(39).fill(40);
      await storage.deleteLink(link.createLinkHash, deleteHash);

      const links = await storage.getLinks(link.baseAddress, dnaHash, agentPubKey);
      expect(links).toHaveLength(1);
      expect(links[0].deleted).toBe(true);
      expect(links[0].deleteHash).toBeDefined();
      expect(Array.from(links[0].deleteHash!)).toEqual(Array.from(deleteHash));
    });
  });

  describe('Details Operations', () => {
    it('should get details with CRUD history', async () => {
      const entryHash = new Uint8Array(39).fill(50);
      const entryContent = new Uint8Array([1, 2, 3]);

      // Create action
      const createAction: CreateAction = {
        actionHash: new Uint8Array(39).fill(51),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: null,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash,
        entryType: { zome_id: 0, entry_index: 0 },
      };

      // Update action
      const updateAction: UpdateAction = {
        actionHash: new Uint8Array(39).fill(52),
        actionSeq: 2,
        author: agentPubKey,
        timestamp: 6000n,
        prevActionHash: createAction.actionHash,
        actionType: 'Update',
        signature: new Uint8Array(64).fill(21),
        entryHash: new Uint8Array(39).fill(53),
        entryType: { zome_id: 0, entry_index: 0 },
        originalActionHash: createAction.actionHash,
        originalEntryHash: entryHash,
      };

      // Delete action
      const deleteAction: DeleteAction = {
        actionHash: new Uint8Array(39).fill(54),
        actionSeq: 3,
        author: agentPubKey,
        timestamp: 7000n,
        prevActionHash: updateAction.actionHash,
        actionType: 'Delete',
        signature: new Uint8Array(64).fill(22),
        deletesActionHash: createAction.actionHash,
        deletesEntryHash: entryHash,
      };

      await storage.putAction(createAction, dnaHash, agentPubKey);
      await storage.putAction(updateAction, dnaHash, agentPubKey);
      await storage.putAction(deleteAction, dnaHash, agentPubKey);
      await storage.putEntry(
        {
          entryHash,
          entryContent,
          entryType: { zome_id: 0, entry_index: 0 },
        },
        dnaHash,
        agentPubKey
      );

      const details = await storage.getDetailsFromDb(entryHash, dnaHash, agentPubKey);
      expect(details).not.toBeNull();
      expect(details!.record.action.actionType).toBe('Create');
      expect(details!.updates).toHaveLength(1);
      expect(details!.updates[0].updateAction.actionSeq).toBe(2);
      expect(details!.deletes).toHaveLength(1);
      expect(details!.deletes[0].deleteAction.actionSeq).toBe(3);
      expect(details!.validationStatus).toBe('Valid');
    });
  });

  describe('Transaction Support', () => {
    it('should batch operations in a transaction', async () => {
      const action: CreateAction = {
        actionHash: new Uint8Array(39).fill(60),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: null,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash: new Uint8Array(39).fill(61),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      const entry = {
        entryHash: action.entryHash,
        entryContent: new Uint8Array([1, 2, 3]),
        entryType: { zome_id: 0, entry_index: 0 } as const,
      };

      // Begin transaction
      storage.beginTransaction();
      expect(storage.isTransactionActive()).toBe(true);

      // Queue operations
      await storage.putAction(action, dnaHash, agentPubKey);
      await storage.putEntry(entry, dnaHash, agentPubKey);
      await storage.updateChainHead(dnaHash, agentPubKey, 1, action.actionHash, 5000n);

      // Session cache makes data available immediately (before commit)
      const actionBefore = await storage.getAction(action.actionHash);
      expect(actionBefore).not.toBeNull();
      expect(actionBefore!.actionSeq).toBe(1);

      const entryBefore = await storage.getEntry(entry.entryHash);
      expect(entryBefore).not.toBeNull();

      // Commit transaction
      await storage.commitTransaction();
      expect(storage.isTransactionActive()).toBe(false);

      // Data still accessible after commit (now from IndexedDB)
      const actionAfter = await storage.getAction(action.actionHash);
      expect(actionAfter).not.toBeNull();
      expect(actionAfter!.actionSeq).toBe(1);

      const entryAfter = await storage.getEntry(entry.entryHash);
      expect(entryAfter).not.toBeNull();

      const chainHead = await storage.getChainHead(dnaHash, agentPubKey);
      expect(chainHead).not.toBeNull();
      expect(chainHead!.actionSeq).toBe(1);
    });

    it('should rollback transaction', async () => {
      const action: CreateAction = {
        actionHash: new Uint8Array(39).fill(70),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: null,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash: new Uint8Array(39).fill(71),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      // Begin transaction
      storage.beginTransaction();

      // Queue operation
      await storage.putAction(action, dnaHash, agentPubKey);

      // Rollback
      storage.rollbackTransaction();
      expect(storage.isTransactionActive()).toBe(false);

      // Nothing should be persisted
      const actionAfter = await storage.getAction(action.actionHash);
      expect(actionAfter).toBeNull();
    });

    it('should handle link deletion in transaction', async () => {
      const link: Link = {
        createLinkHash: new Uint8Array(39).fill(80),
        baseAddress: new Uint8Array(39).fill(81),
        targetAddress: new Uint8Array(39).fill(82),
        timestamp: 7000n,
        zomeIndex: 0,
        linkType: 0,
        tag: new Uint8Array([1, 2, 3]),
        author: agentPubKey,
        deleted: false,
      };

      // Create link first (outside transaction)
      await storage.putLink(link, dnaHash, agentPubKey);

      // Begin transaction to delete it
      storage.beginTransaction();

      const deleteHash = new Uint8Array(39).fill(83);
      await storage.deleteLink(link.createLinkHash, deleteHash);

      // Commit
      await storage.commitTransaction();

      // Link should be marked as deleted after commit
      const linksAfter = await storage.getLinks(link.baseAddress, dnaHash, agentPubKey);
      expect(linksAfter[0].deleted).toBe(true);
      expect(linksAfter[0].deleteHash).toEqual(deleteHash);
    });
  });
});
