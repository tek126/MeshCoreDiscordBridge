import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  UNSCOPED,
  normalizeScopeName,
  scopeKeyForName,
  validateScopeValue,
  resolveChannelScopes,
  calcTransportCode,
  matchScopeName,
} from "../lib/scopes.js";

describe("normalizeScopeName", () => {
  it("strips a leading # and whitespace", () => {
    assert.equal(normalizeScopeName(" #troy "), "troy");
    assert.equal(normalizeScopeName("troy"), "troy");
  });

  it("keeps case, since the firmware hashes the name as typed", () => {
    assert.equal(normalizeScopeName("#Troy"), "Troy");
  });

  it("returns empty for non-strings", () => {
    assert.equal(normalizeScopeName(null), "");
    assert.equal(normalizeScopeName(5), "");
  });
});

describe("scopeKeyForName", () => {
  it("is the first 16 bytes of SHA-256 of #name, like the firmware", () => {
    const expected = crypto.createHash("sha256").update("#troy").digest().subarray(0, 16);
    assert.deepEqual(scopeKeyForName("troy"), expected);
    assert.deepEqual(scopeKeyForName("#troy"), expected);
    assert.equal(scopeKeyForName("troy").length, 16);
  });
});

describe("validateScopeValue", () => {
  it("accepts region names and the unscoped marker", () => {
    assert.equal(validateScopeValue("troy"), null);
    assert.equal(validateScopeValue("#troy"), null);
    assert.equal(validateScopeValue(UNSCOPED), null);
  });

  it("rejects empty, private, overlong and non-string values", () => {
    assert.match(validateScopeValue(""), /empty/);
    assert.match(validateScopeValue("#"), /empty/);
    assert.match(validateScopeValue("$secret"), /private/);
    assert.match(validateScopeValue("x".repeat(31)), /longer/);
    assert.match(validateScopeValue(3), /string/);
  });
});

describe("resolveChannelScopes", () => {
  const routes = { "1475651417351131237": 2, "1475203223852814470": 3 };

  it("maps mesh channel indexes directly", () => {
    const { byIdx, warnings } = resolveChannelScopes({ "2": "#troy", "5": "*" }, routes);
    assert.deepEqual([...byIdx], [[2, "troy"], [5, UNSCOPED]]);
    assert.deepEqual(warnings, []);
  });

  it("maps routed Discord channel IDs to their mesh index", () => {
    const { byIdx } = resolveChannelScopes({ "1475203223852814470": "testing" }, routes);
    assert.deepEqual([...byIdx], [[3, "testing"]]);
  });

  it("lets an explicit mesh index win over a Discord ID for the same channel", () => {
    const { byIdx, warnings } = resolveChannelScopes({ "1475651417351131237": "albany", "2": "troy" }, routes);
    assert.equal(byIdx.get(2), "troy");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /conflicts/);
  });

  it("skips unknown keys and invalid values with warnings", () => {
    const { byIdx, warnings } = resolveChannelScopes(
      { "999999999999999999": "troy", "abc": "troy", "4": "$priv", "6": "" }, routes);
    assert.equal(byIdx.size, 0);
    assert.equal(warnings.length, 4);
  });

  it("returns nothing for missing or malformed config", () => {
    assert.equal(resolveChannelScopes(undefined).byIdx.size, 0);
    assert.equal(resolveChannelScopes([]).byIdx.size, 0);
    assert.equal(resolveChannelScopes("troy").byIdx.size, 0);
  });
});

describe("calcTransportCode / matchScopeName", () => {
  const payload = Buffer.from("0a1b2c3d4e5f60718293a4b5c6d7e8f9", "hex");

  it("matches HMAC-SHA256(key, type || payload), first two bytes little-endian", () => {
    const key = scopeKeyForName("alb");
    const mac = crypto.createHmac("sha256", key).update(Buffer.concat([Buffer.of(5), payload])).digest();
    const expected = mac.readUInt16LE(0);
    assert.equal(calcTransportCode(key, 5, payload), expected === 0 ? 1 : expected === 0xFFFF ? 0xFFFE : expected);
  });

  it("finds the region that produced a code, and nothing for other regions", () => {
    const code = calcTransportCode(scopeKeyForName("alb"), 5, payload);
    assert.equal(matchScopeName(code, 5, payload, ["troy", "#alb"]), "alb");
    assert.equal(matchScopeName(code, 5, payload, ["troy"]), null);
    assert.equal(matchScopeName(code, 4, payload, ["alb"]) === "alb", false); // type is part of the MAC
  });
});
