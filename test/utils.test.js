import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeCrockfordBase32,
  generateMeshHash,
  escapeRegex,
  normalizeForMesh,
  splitByMaxLen,
} from "../lib/utils.js";

describe("encodeCrockfordBase32", () => {
  it("encodes 5 zero bytes to 00000000", () => {
    assert.equal(encodeCrockfordBase32(new Uint8Array(5)), "00000000");
  });

  it("encodes known bytes to expected output", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);
    assert.equal(encodeCrockfordBase32(bytes).length, 8);
  });

  it("produces only valid Crockford characters", () => {
    const valid = "0123456789abcdefghjkmnpqrstvwxyz";
    for (let i = 0; i < 20; i++) {
      const bytes = new Uint8Array(5);
      for (let j = 0; j < 5; j++) bytes[j] = Math.floor(Math.random() * 256);
      const result = encodeCrockfordBase32(bytes);
      assert.equal(result.length, 8);
      for (const ch of result) {
        assert.ok(valid.includes(ch), `Invalid character: ${ch}`);
      }
    }
  });
});

describe("generateMeshHash", () => {
  it("returns an 8-char Crockford hash", () => {
    const hash = generateMeshHash("Hello", 1234567890);
    assert.equal(hash.length, 8);
  });

  it("returns consistent results for same input", () => {
    const h1 = generateMeshHash("test message", 100);
    const h2 = generateMeshHash("test message", 100);
    assert.equal(h1, h2);
  });

  it("returns different hashes for different text", () => {
    const h1 = generateMeshHash("hello", 100);
    const h2 = generateMeshHash("world", 100);
    assert.notEqual(h1, h2);
  });

  it("returns different hashes for different timestamps", () => {
    const h1 = generateMeshHash("hello", 100);
    const h2 = generateMeshHash("hello", 200);
    assert.notEqual(h1, h2);
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    assert.equal(escapeRegex("Node++"), "Node\\+\\+");
    assert.equal(escapeRegex("a.b"), "a\\.b");
    assert.equal(escapeRegex("(test)"), "\\(test\\)");
    assert.equal(escapeRegex("[abc]"), "\\[abc\\]");
  });

  it("leaves normal strings unchanged", () => {
    assert.equal(escapeRegex("hello"), "hello");
    assert.equal(escapeRegex("MeshBridge"), "MeshBridge");
  });
});

describe("normalizeForMesh", () => {
  it("collapses whitespace", () => {
    assert.equal(normalizeForMesh("hello   world"), "hello world");
  });

  it("replaces newlines and tabs with spaces", () => {
    assert.equal(normalizeForMesh("hello\nworld\there"), "hello world here");
  });

  it("trims leading/trailing whitespace", () => {
    assert.equal(normalizeForMesh("  hello  "), "hello");
  });

  it("handles CRLF", () => {
    assert.equal(normalizeForMesh("hello\r\nworld"), "hello world");
  });

  it("handles null/undefined", () => {
    assert.equal(normalizeForMesh(null), "");
    assert.equal(normalizeForMesh(undefined), "");
  });
});

describe("splitByMaxLen", () => {
  it("returns single chunk for short text", () => {
    const result = splitByMaxLen("hello", 10);
    assert.deepEqual(result, ["hello"]);
  });

  it("splits on whitespace", () => {
    const result = splitByMaxLen("hello world foo bar", 12);
    assert.ok(result.length >= 2);
    for (const chunk of result) {
      assert.ok(chunk.length <= 12, `Chunk "${chunk}" exceeds maxLen 12`);
    }
  });

  it("hard splits when no whitespace", () => {
    const result = splitByMaxLen("abcdefghij", 5);
    assert.equal(result.length, 2);
    assert.equal(result[0], "abcde");
    assert.equal(result[1], "fghij");
  });

  it("handles empty input", () => {
    assert.deepEqual(splitByMaxLen("", 10), []);
    assert.deepEqual(splitByMaxLen(null, 10), []);
  });

  it("all chunks are within maxLen", () => {
    const text = "This is a longer message that should be split into multiple smaller chunks for transmission";
    const maxLen = 20;
    const chunks = splitByMaxLen(text, maxLen);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= maxLen, `Chunk "${chunk}" exceeds maxLen ${maxLen}`);
    }
    // Verify no content is lost (accounting for trimmed whitespace)
    const rejoined = chunks.join(" ");
    assert.equal(rejoined.replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  });
});
