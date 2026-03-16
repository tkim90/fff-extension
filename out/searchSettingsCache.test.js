"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/searchSettingsCache.test.ts
var import_node_test = require("node:test");
var assert = __toESM(require("node:assert/strict"));

// src/searchSettingsCache.ts
var DEFAULT_SETTINGS = {
  query: "",
  caseSensitive: false,
  wordMatch: false,
  regexEnabled: false
};
var SearchSettingsCache = class _SearchSettingsCache {
  constructor(store) {
    this.store = store;
  }
  static STORAGE_KEY = "searchSettings";
  get() {
    return this.store.get(_SearchSettingsCache.STORAGE_KEY) ?? { ...DEFAULT_SETTINGS };
  }
  update(partial) {
    void this.store.update(_SearchSettingsCache.STORAGE_KEY, { ...this.get(), ...partial });
  }
};

// src/searchSettingsCache.test.ts
var InMemoryStore = class {
  data = /* @__PURE__ */ new Map();
  get(key) {
    return this.data.get(key);
  }
  update(key, value) {
    this.data.set(key, value);
    return Promise.resolve();
  }
};
var DEFAULTS = {
  query: "",
  caseSensitive: false,
  wordMatch: false,
  regexEnabled: false
};
(0, import_node_test.describe)("SearchSettingsCache", () => {
  (0, import_node_test.it)("returns defaults when store is empty", () => {
    const cache = new SearchSettingsCache(new InMemoryStore());
    assert.deepStrictEqual(cache.get(), DEFAULTS);
  });
  (0, import_node_test.it)("returns a copy, not a shared reference", () => {
    const cache = new SearchSettingsCache(new InMemoryStore());
    const a = cache.get();
    const b = cache.get();
    assert.notStrictEqual(a, b);
  });
  (0, import_node_test.it)("updates a single field and preserves defaults for the rest", () => {
    const cache = new SearchSettingsCache(new InMemoryStore());
    cache.update({ query: "hello" });
    assert.deepStrictEqual(cache.get(), { ...DEFAULTS, query: "hello" });
  });
  (0, import_node_test.it)("preserves existing fields across sequential partial updates", () => {
    const cache = new SearchSettingsCache(new InMemoryStore());
    cache.update({ query: "foo" });
    cache.update({ caseSensitive: true });
    cache.update({ regexEnabled: true });
    assert.deepStrictEqual(cache.get(), {
      query: "foo",
      caseSensitive: true,
      wordMatch: false,
      regexEnabled: true
    });
  });
  (0, import_node_test.it)("overwrites all fields at once", () => {
    const cache = new SearchSettingsCache(new InMemoryStore());
    cache.update({ query: "first" });
    const full = {
      query: "second",
      caseSensitive: true,
      wordMatch: true,
      regexEnabled: true
    };
    cache.update(full);
    assert.deepStrictEqual(cache.get(), full);
  });
  (0, import_node_test.it)("multiple cache instances sharing the same store see each other's writes", () => {
    const store = new InMemoryStore();
    const cacheA = new SearchSettingsCache(store);
    const cacheB = new SearchSettingsCache(store);
    cacheA.update({ query: "shared" });
    assert.strictEqual(cacheB.get().query, "shared");
  });
});
