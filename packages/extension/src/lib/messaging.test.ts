import { describe, it, expect } from "vitest";
import {
  MessageType,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createSignal,
  isRequestMessage,
  isResponseMessage,
  isSignalMessage,
  serializeMessage,
  deserializeMessage,
  generateMessageId,
  type RequestMessage,
  type ResponseMessage,
  type SignalMessage,
  type ZomeCallPayload,
} from "./messaging";

describe("messaging protocol", () => {
  describe("generateMessageId", () => {
    it("should generate unique IDs", () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it("should generate IDs in the expected format", () => {
      const id = generateMessageId();
      expect(id).toMatch(/^\d+-[a-z0-9]+$/);
    });
  });

  describe("createRequest", () => {
    it("should create a CONNECT request", () => {
      const request = createRequest(MessageType.CONNECT);

      expect(request.type).toBe(MessageType.CONNECT);
      expect(request.id).toBeTruthy();
      expect(request.timestamp).toBeGreaterThan(0);
      expect(request.payload).toBeUndefined();
    });

    it("should create a request with payload", () => {
      const payload = { test: "data" };
      const request = createRequest(MessageType.CALL_ZOME, payload);

      expect(request.type).toBe(MessageType.CALL_ZOME);
      expect(request.payload).toEqual(payload);
    });
  });

  describe("createSuccessResponse", () => {
    it("should create a success response", () => {
      const requestId = "test-request-id";
      const payload = { result: "success" };
      const response = createSuccessResponse(requestId, payload);

      expect(response.type).toBe(MessageType.SUCCESS);
      expect(response.requestId).toBe(requestId);
      expect(response.payload).toEqual(payload);
      expect(response.id).toBeTruthy();
      expect(response.timestamp).toBeGreaterThan(0);
    });
  });

  describe("createErrorResponse", () => {
    it("should create an error response", () => {
      const requestId = "test-request-id";
      const error = "Something went wrong";
      const response = createErrorResponse(requestId, error);

      expect(response.type).toBe(MessageType.ERROR);
      expect(response.requestId).toBe(requestId);
      expect(response.error).toBe(error);
      expect(response.id).toBeTruthy();
      expect(response.timestamp).toBeGreaterThan(0);
    });
  });

  describe("createSignal", () => {
    it("should create a signal message", () => {
      const payload = { signal: "data" };
      const signal = createSignal(payload);

      expect(signal.type).toBe(MessageType.SIGNAL);
      expect(signal.payload).toEqual(payload);
      expect(signal.id).toBeTruthy();
      expect(signal.timestamp).toBeGreaterThan(0);
    });
  });

  describe("type guards", () => {
    it("should identify request messages", () => {
      const request = createRequest(MessageType.CONNECT);
      const response = createSuccessResponse("test", {});
      const signal = createSignal({});

      expect(isRequestMessage(request)).toBe(true);
      expect(isRequestMessage(response)).toBe(false);
      expect(isRequestMessage(signal)).toBe(false);
    });

    it("should identify response messages", () => {
      const request = createRequest(MessageType.CONNECT);
      const successResponse = createSuccessResponse("test", {});
      const errorResponse = createErrorResponse("test", "error");
      const signal = createSignal({});

      expect(isResponseMessage(request)).toBe(false);
      expect(isResponseMessage(successResponse)).toBe(true);
      expect(isResponseMessage(errorResponse)).toBe(true);
      expect(isResponseMessage(signal)).toBe(false);
    });

    it("should identify signal messages", () => {
      const request = createRequest(MessageType.CONNECT);
      const response = createSuccessResponse("test", {});
      const signal = createSignal({});

      expect(isSignalMessage(request)).toBe(false);
      expect(isSignalMessage(response)).toBe(false);
      expect(isSignalMessage(signal)).toBe(true);
    });
  });

  describe("serialization", () => {
    it("should serialize and deserialize simple messages", () => {
      const original = createRequest(MessageType.CONNECT, { test: "data" });
      const serialized = serializeMessage(original);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized).toEqual(original);
    });

    it("should serialize and deserialize Uint8Array in payload", () => {
      const payload = {
        data: new Uint8Array([1, 2, 3, 4, 5]),
        nested: {
          array: new Uint8Array([10, 20, 30]),
        },
      };
      const original = createRequest(MessageType.CALL_ZOME, payload);
      const serialized = serializeMessage(original);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.payload).toEqual(payload);
      expect((deserialized.payload as any).data).toBeInstanceOf(Uint8Array);
      expect((deserialized.payload as any).nested.array).toBeInstanceOf(
        Uint8Array
      );
      expect(Array.from((deserialized.payload as any).data)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(Array.from((deserialized.payload as any).nested.array)).toEqual([
        10, 20, 30,
      ]);
    });

    it("should handle ZomeCallPayload with Uint8Arrays", () => {
      const payload: ZomeCallPayload = {
        cell_id: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
        zome_name: "test_zome",
        fn_name: "test_fn",
        payload: { test: "data" },
        provenance: new Uint8Array([7, 8, 9]),
        cap_secret: null,
      };

      const original = createRequest(MessageType.CALL_ZOME, payload);
      const serialized = serializeMessage(original);
      const deserialized = deserializeMessage(serialized);

      const deserializedPayload = deserialized.payload as ZomeCallPayload;
      expect(deserializedPayload.cell_id[0]).toBeInstanceOf(Uint8Array);
      expect(deserializedPayload.cell_id[1]).toBeInstanceOf(Uint8Array);
      expect(deserializedPayload.provenance).toBeInstanceOf(Uint8Array);
      expect(Array.from(deserializedPayload.cell_id[0])).toEqual([1, 2, 3]);
      expect(Array.from(deserializedPayload.cell_id[1])).toEqual([4, 5, 6]);
      expect(Array.from(deserializedPayload.provenance)).toEqual([7, 8, 9]);
    });

    it("should handle response messages", () => {
      const original = createSuccessResponse("req-123", {
        result: new Uint8Array([100, 101, 102]),
      });
      const serialized = serializeMessage(original);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized).toEqual(original);
      expect((deserialized.payload as any).result).toBeInstanceOf(Uint8Array);
    });

    it("should handle signal messages", () => {
      const original = createSignal({
        data: new Uint8Array([200, 201, 202]),
      });
      const serialized = serializeMessage(original);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized).toEqual(original);
      expect((deserialized.payload as any).data).toBeInstanceOf(Uint8Array);
    });
  });

  describe("message structure validation", () => {
    it("should have required fields in request message", () => {
      const request = createRequest(MessageType.CONNECT);

      expect(request).toHaveProperty("type");
      expect(request).toHaveProperty("id");
      expect(request).toHaveProperty("timestamp");
    });

    it("should have required fields in response message", () => {
      const response = createSuccessResponse("req-123", {});

      expect(response).toHaveProperty("type");
      expect(response).toHaveProperty("id");
      expect(response).toHaveProperty("timestamp");
      expect(response).toHaveProperty("requestId");
    });

    it("should have required fields in signal message", () => {
      const signal = createSignal({});

      expect(signal).toHaveProperty("type");
      expect(signal).toHaveProperty("id");
      expect(signal).toHaveProperty("timestamp");
      expect(signal).toHaveProperty("payload");
    });
  });
});
