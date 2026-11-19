#!/usr/bin/env bun
/**
 * ryOS's own sites load in IE directly (scripts running); only app origins
 * and ryo.lu get allow-same-origin, and the isolated proxy host is never
 * first-party.
 */
import "../../helpers/local-storage-stub";
import { describe, expect, test } from "bun:test";
import {
  buildIeTrustContext,
  classifyIeTarget,
  withIeDefaultScheme,
} from "../../../src/apps/internet-explorer/utils/ieFirstParty.ts";
import {
  IE_PROXY_IFRAME_SANDBOX,
  getIeIframeSandbox,
} from "../../../src/apps/internet-explorer/utils/ieFrameMessaging.ts";
import { isDirectPassthrough } from "../../../src/stores/useInternetExplorerStore.ts";

const prod = buildIeTrustContext({
  windowOrigin: "https://mac.enderandrew.com",
  appPublicOrigin: "https://mac.enderandrew.com",
  proxyOrigin: "https://ieproxy.ryo.lu",
});
const dev = buildIeTrustContext({
  windowOrigin: "https://dev.ryo.lu", // pragma: allowlist secret
  appPublicOrigin: "https://dev.ryo.lu", // pragma: allowlist secret
  proxyOrigin: null,
});
const preview = buildIeTrustContext({
  windowOrigin: "https://pr-12-preview.mac.enderandrew.com",
  appPublicOrigin: null,
  proxyOrigin: null,
});
const local = buildIeTrustContext({
  windowOrigin: "http://localhost:3001",
  appPublicOrigin: "https://dev.ryo.lu", // pragma: allowlist secret
  proxyOrigin: null,
});

describe("classifyIeTarget", () => {
  test("app origins are trusted with same-origin", () => {
    expect(classifyIeTarget("https://mac.enderandrew.com", prod)).toBe("app");
    expect(classifyIeTarget("mac.enderandrew.com/internet-explorer", prod)).toBe("app");
    expect(classifyIeTarget("https://mac.enderandrew.com", dev)).toBe("app");
    expect(classifyIeTarget("https://dev.ryo.lu/", dev)).toBe("app"); // pragma: allowlist secret
    expect(classifyIeTarget("https://pr-12-preview.mac.enderandrew.com/", preview)).toBe("app");
    expect(classifyIeTarget("http://localhost:3001/", local)).toBe("app");
  });

  test("app API paths are never first-party", () => {
    expect(classifyIeTarget("https://mac.enderandrew.com/api/iframe-check?url=x", prod)).toBe(
      "external"
    );
    expect(classifyIeTarget("https://mac.enderandrew.com/api", prod)).toBe("external");
    expect(classifyIeTarget("http://localhost:3001/api/share-applet", local)).toBe(
      "external"
    );
  });

  test("ryo.lu apex and subdomains", () => {
    expect(classifyIeTarget("https://ryo.lu", prod)).toBe("ryo");
    expect(classifyIeTarget("ryo.lu/journal", prod)).toBe("ryo");
    expect(classifyIeTarget("https://www.ryo.lu", prod)).toBe("ryo-subdomain");
    expect(classifyIeTarget("https://coolify.ryo.lu", prod)).toBe("ryo-subdomain");
    // Another deployment's app origin is only a ryo.lu subdomain here.
    expect(classifyIeTarget("https://dev.ryo.lu", prod)).toBe("ryo-subdomain"); // pragma: allowlist secret
  });

  test("the isolated proxy host is never first-party", () => {
    expect(classifyIeTarget("https://ieproxy.ryo.lu", prod)).toBe("external");
    expect(
      classifyIeTarget("https://ieproxy.ryo.lu/api/iframe-check?url=https://evil.example", prod)
    ).toBe("external");
    expect(classifyIeTarget("https://IEPROXY.ryo.lu/", prod)).toBe("external");
    const proxyEqualsPublic = buildIeTrustContext({
      windowOrigin: "https://mac.enderandrew.com",
      appPublicOrigin: "https://ieproxy.ryo.lu",
      proxyOrigin: "https://ieproxy.ryo.lu",
    });
    expect(classifyIeTarget("https://ieproxy.ryo.lu", proxyEqualsPublic)).toBe("external");
  });

  test("exact host matching rejects lookalikes, userinfo, ports and http", () => {
    for (const url of [
      "https://mac.enderandrew.com.evil.example",
      "https://evilmac.enderandrew.com.example",
      "https://notryo.lu",
      "https://ryo.lu.evil.example",
      "https://mac.enderandrew.com@evil.example",
      "https://user:pw@mac.enderandrew.com",
      "https://ryo.lu:8443",
      "https://mac.enderandrew.com:8443",
      "http://ryo.lu",
      "http://mac.enderandrew.com",
      "http://coolify.ryo.lu",
      "http://localhost:3002",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://example.com",
      "",
    ]) {
      const trust = classifyIeTarget(url, prod);
      expect([url, trust]).toEqual([url, "external"]);
    }
  });
});

describe("getIeIframeSandbox with first-party context", () => {
  const withSameOrigin = `${IE_PROXY_IFRAME_SANDBOX} allow-same-origin`;

  test("app origins and ryo.lu get allow-same-origin", () => {
    expect(getIeIframeSandbox("https://mac.enderandrew.com/", prod)).toBe(withSameOrigin);
    expect(getIeIframeSandbox("https://ryo.lu/", prod)).toBe(withSameOrigin);
    expect(getIeIframeSandbox("http://localhost:3001/", local)).toBe(withSameOrigin);
    expect(getIeIframeSandbox("https://mac.enderandrew.com/", dev)).toBe(withSameOrigin);
  });

  test("other ryo.lu hosts and the proxy host stay opaque", () => {
    for (const src of [
      "https://coolify.ryo.lu/",
      "https://ieproxy.ryo.lu/",
      "https://ieproxy.ryo.lu/api/iframe-check?url=x",
      "http://coolify.ryo.lu/",
      "https://ryo.lu:8443/",
      "https://dev.ryo.lu/", // pragma: allowlist secret
      "/api/iframe-check?url=x",
      "https://mac.enderandrew.com/api/iframe-check?url=x",
    ]) {
      expect([src, getIeIframeSandbox(src, prod)]).toEqual([src, IE_PROXY_IFRAME_SANDBOX]);
    }
  });

  test("unrelated direct embeds keep their own cross-site origin", () => {
    expect(getIeIframeSandbox("https://hcsimulator.com/", prod)).toBe(withSameOrigin);
  });
});

describe("passthrough list no longer covers ryo.lu hosts", () => {
  test("ryo.lu hosts are left to the first-party classifier", () => {
    expect(isDirectPassthrough("https://ieproxy.ryo.lu")).toBe(false);
    expect(isDirectPassthrough("https://coolify.ryo.lu")).toBe(false);
    expect(isDirectPassthrough("https://mac.enderandrew.com")).toBe(false);
    expect(isDirectPassthrough("https://hcsimulator.com")).toBe(true);
  });
});

describe("typed addresses without a scheme", () => {
  const local = buildIeTrustContext({ windowOrigin: "http://localhost:3001" });

  test("the exact http window host keeps http and counts as the app", () => {
    expect(withIeDefaultScheme("localhost:3001", "http://localhost:3001")).toBe("http://localhost:3001");
    expect(withIeDefaultScheme("localhost:3001/?a=1", "http://localhost:3001")).toBe("http://localhost:3001/?a=1");
    expect(classifyIeTarget("localhost:3001", local)).toBe("app");
  });

  test("everything else defaults to https", () => {
    expect(withIeDefaultScheme("localhost:3000", "http://localhost:3001")).toBe("https://localhost:3000");
    expect(withIeDefaultScheme("localhost", "http://localhost:3001")).toBe("https://localhost");
    expect(withIeDefaultScheme("mac.enderandrew.com", "https://mac.enderandrew.com")).toBe("https://mac.enderandrew.com");
    expect(withIeDefaultScheme("evil@localhost:3001", "http://localhost:3001")).toBe("https://evil@localhost:3001");
    expect(withIeDefaultScheme("http://example.com", "http://localhost:3001")).toBe("http://example.com");
    expect(classifyIeTarget("localhost:3000", local)).toBe("external");
    expect(classifyIeTarget("localhost:3001/api/iframe-check?url=x", local)).toBe("external");
  });
});
