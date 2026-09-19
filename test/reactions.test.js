import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPocketMeshReact, parseMeshReaction } from "../lib/reactions.js";

describe("isPocketMeshReact", () => {
  describe("new format (emoji after target name)", () => {
    it("detects react with sender prefix", () => {
      assert.ok(isPocketMeshReact("WO2H Seed \u{1F692}: @[EPM-CA]\u{1F44B}\nq4c80y5v"));
    });

    it("detects react without sender prefix", () => {
      assert.ok(isPocketMeshReact("@[SomeUser]\u{1F44D}\nabcd1234"));
    });

    it("detects react with emoji in target name", () => {
      assert.ok(isPocketMeshReact("MC-T1000: @[\u{1F921}Gaptastic]\u{1F44B}\nz86m7w76"));
    });
  });

  describe("old format (emoji before target name)", () => {
    it("detects old format react", () => {
      assert.ok(isPocketMeshReact("\u{1F600}@[Some User]xp8q7fcc"));
    });

    it("detects old format with sender prefix", () => {
      assert.ok(isPocketMeshReact("Sender: \u{1F600}@[Some User]\nxp8q7fcc"));
    });
  });

  describe("non-react messages", () => {
    it("rejects regular messages", () => {
      assert.ok(!isPocketMeshReact("Hello world"));
    });

    it("rejects messages with @mentions but no hash", () => {
      assert.ok(!isPocketMeshReact("EPM-CA: @[N1XWS Card] Hi Hi!"));
    });

    it("rejects null/empty", () => {
      assert.ok(!isPocketMeshReact(null));
      assert.ok(!isPocketMeshReact(""));
    });

    it("rejects trace/path messages that contain @[name]", () => {
      assert.ok(!isPocketMeshReact("Roberto: @[P-T1000E] Received in Albany, NY. Tracing 3 hops..."));
    });
  });
});

describe("parseMeshReaction", () => {
  describe("new format", () => {
    it("parses emoji, target, and hash", () => {
      const result = parseMeshReaction("WO2H Seed \u{1F692}: @[EPM-CA]\u{1F44B}\nq4c80y5v");
      assert.deepEqual(result, { emoji: "\u{1F44B}", targetName: "EPM-CA", hash: "q4c80y5v" });
    });

    it("parses thumbs up react", () => {
      const result = parseMeshReaction("MC-T1000E-1: @[N1XWS Card]\u{1F44D}\nzhz299ty");
      assert.deepEqual(result, { emoji: "\u{1F44D}", targetName: "N1XWS Card", hash: "zhz299ty" });
    });

    it("handles emoji in target name", () => {
      const result = parseMeshReaction("MC-T1000: @[\u{1F921}Gaptastic]\u{1F44B}\nz86m7w76");
      assert.equal(result.targetName, "\u{1F921}Gaptastic");
      assert.equal(result.emoji, "\u{1F44B}");
      assert.equal(result.hash, "z86m7w76");
    });
  });

  describe("old format", () => {
    it("parses old format react", () => {
      const result = parseMeshReaction("\u{1F600}@[Some User]xp8q7fcc");
      assert.deepEqual(result, { emoji: "\u{1F600}", targetName: "Some User", hash: "xp8q7fcc" });
    });

    it("parses old format with sender and newline", () => {
      const result = parseMeshReaction("Sender: \u{1F600}@[Some User]\nxp8q7fcc");
      assert.deepEqual(result, { emoji: "\u{1F600}", targetName: "Some User", hash: "xp8q7fcc" });
    });
  });

  it("returns null for non-react messages", () => {
    assert.equal(parseMeshReaction("Hello world"), null);
    assert.equal(parseMeshReaction("EPM-CA: @[Someone] Hi!"), null);
  });
});
