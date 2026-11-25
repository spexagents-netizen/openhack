import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "../src/main/browser/url";

describe("browser URL policy", () => {
  it("only admits HTTP(S) and upgrades a bare host", () => {
    expect(normalizeBrowserUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeBrowserUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrl("")).toBeNull();
    expect(normalizeBrowserUrl("   ")).toBeNull();
  });

  it("refuses local files, data, javascript and malformed input", () => {
    expect(normalizeBrowserUrl("file:///C:/Windows/win.ini")).toBeNull();
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("data:text/html,<h1>x</h1>")).toBeNull();
    expect(normalizeBrowserUrl("ftp://example.com/file")).toBeNull();
    expect(normalizeBrowserUrl("://bad")).toBeNull();
  });
});
