import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../lib/config.js";

describe("validateConfig", () => {
  const validConfig = {
    CLIENT_ID: "123456789",
    DISCORD_TOKEN: "some-token",
    DISCORD_CHANNEL_ID: "987654321",
    GUILD_IDS: ["111111"],
  };

  it("accepts valid config without warnings", () => {
    const warnings = validateConfig(validConfig);
    assert.equal(warnings.length, 0);
  });

  it("throws on missing CLIENT_ID", () => {
    const cfg = { ...validConfig, CLIENT_ID: undefined };
    assert.throws(() => validateConfig(cfg), /CLIENT_ID/);
  });

  it("throws on missing DISCORD_TOKEN", () => {
    const cfg = { ...validConfig, DISCORD_TOKEN: "" };
    assert.throws(() => validateConfig(cfg), /DISCORD_TOKEN/);
  });

  it("throws on missing GUILD_IDS without GUILD_ID fallback", () => {
    const cfg = { ...validConfig, GUILD_IDS: [] };
    assert.throws(() => validateConfig(cfg), /GUILD_IDS/);
  });

  it("accepts GUILD_ID as fallback for GUILD_IDS", () => {
    const cfg = { ...validConfig, GUILD_IDS: [], GUILD_ID: "123" };
    const warnings = validateConfig(cfg);
    // Should not throw
  });

  it("warns on wrong type for optional keys", () => {
    const cfg = { ...validConfig, MESH_MAXLEN: "not a number" };
    const warnings = validateConfig(cfg);
    assert.ok(warnings.some(w => w.includes("MESH_MAXLEN")));
  });

  it("warns when array key is not an array", () => {
    const cfg = { ...validConfig, BRIDGE_PREFIXES: "not-an-array" };
    const warnings = validateConfig(cfg);
    assert.ok(warnings.some(w => w.includes("BRIDGE_PREFIXES")));
  });

  it("does not warn on absent optional keys", () => {
    const warnings = validateConfig(validConfig);
    assert.equal(warnings.length, 0);
  });
});
