import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CREDENTIAL_TTL_MS,
  launchSessionSandbox,
  staticCredentialIssuer,
  type CredentialIssuer,
} from "../src/credentials.js";
import type { SandboxLaunchOptions, SandboxProvider } from "../src/provider.js";

function recordingProvider(): SandboxProvider & {
  launches: SandboxLaunchOptions[];
  stops: number;
} {
  const launches: SandboxLaunchOptions[] = [];
  const provider = {
    name: "recording",
    launches,
    stops: 0,
    launch(options: SandboxLaunchOptions) {
      launches.push(options);
      return Promise.resolve({
        id: `sbx-${launches.length}`,
        status: () => Promise.resolve("running" as const),
        stop: () => {
          provider.stops += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return provider;
}

function countingIssuer(env: Record<string, string>, ttlOverrideMs?: number) {
  const issuer: CredentialIssuer & { revokes: number; requests: string[] } = {
    name: "counting",
    revokes: 0,
    requests: [],
    issue({ sessionId, ttlMs }) {
      issuer.requests.push(sessionId);
      return Promise.resolve({
        env,
        expiresAt: Date.now() + (ttlOverrideMs ?? ttlMs),
        revoke: () => {
          issuer.revokes += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return issuer;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("staticCredentialIssuer", () => {
  it("stamps the requested TTL onto a snapshot of the operator's values", async () => {
    vi.setSystemTime(1_000);
    const source = { GITHUB_TOKEN: "t0ken" };
    const issuer = staticCredentialIssuer(source);
    const grant = await issuer.issue({ sessionId: "s1", ttlMs: 5_000 });

    expect(grant.env).toEqual({ GITHUB_TOKEN: "t0ken" });
    expect(grant.expiresAt).toBe(6_000);
    // A later mutation of the caller's object must not reach an issued grant.
    source.GITHUB_TOKEN = "rotated";
    expect(grant.env["GITHUB_TOKEN"]).toBe("t0ken");
    await expect(grant.revoke()).resolves.toBeUndefined();
  });
});

describe("launchSessionSandbox", () => {
  it("injects the grant at boot, over any non-secret env, and hands the provider the deadline", async () => {
    const provider = recordingProvider();
    const issuer = countingIssuer({ GITHUB_TOKEN: "t0ken", SIDE_STREET_ROLE: "grant" });

    const sandbox = await launchSessionSandbox({
      provider,
      issuer,
      sessionId: "s1",
      repoUrl: "https://example.test/repo.git",
      ttlMs: 30_000,
      env: { SIDE_STREET_ROLE: "base", NODE_ENV: "test" },
    });

    expect(issuer.requests).toEqual(["s1"]);
    expect(provider.launches[0]).toEqual({
      sessionId: "s1",
      repoUrl: "https://example.test/repo.git",
      env: { NODE_ENV: "test", SIDE_STREET_ROLE: "grant", GITHUB_TOKEN: "t0ken" },
      ttlMs: 30_000,
    });
    expect(sandbox.expiresAt).toBe(30_000);
    expect(sandbox.secrets).toEqual(["t0ken", "grant"]);
  });

  it("defaults to the one-hour TTL", async () => {
    const provider = recordingProvider();
    const sandbox = await launchSessionSandbox({
      provider,
      issuer: staticCredentialIssuer({ TOKEN: "t" }),
      sessionId: "s1",
      repoUrl: "https://example.test/repo.git",
    });

    expect(sandbox.expiresAt).toBe(DEFAULT_CREDENTIAL_TTL_MS);
    expect(provider.launches[0]?.ttlMs).toBe(DEFAULT_CREDENTIAL_TTL_MS);
  });

  it("clamps the sandbox to the grant's own deadline, not the requested TTL", async () => {
    const provider = recordingProvider();
    // An issuer whose upstream credential expires sooner than we asked for.
    const issuer = countingIssuer({ TOKEN: "t" }, 5_000);

    const sandbox = await launchSessionSandbox({
      provider,
      issuer,
      sessionId: "s1",
      repoUrl: "https://example.test/repo.git",
      ttlMs: 60_000,
    });

    expect(provider.launches[0]?.ttlMs).toBe(5_000);
    expect(sandbox.expiresAt).toBe(5_000);
  });

  it("stops the sandbox and revokes the grant at expiry", async () => {
    const provider = recordingProvider();
    const issuer = countingIssuer({ TOKEN: "t" });
    const onExpired = vi.fn();

    await launchSessionSandbox({
      provider,
      issuer,
      sessionId: "s1",
      repoUrl: "https://example.test/repo.git",
      ttlMs: 10_000,
      onExpired,
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(provider.stops).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(provider.stops).toBe(1);
    expect(issuer.revokes).toBe(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("disarms expiry once stopped, and stays idempotent", async () => {
    const provider = recordingProvider();
    const issuer = countingIssuer({ TOKEN: "t" });

    const sandbox = await launchSessionSandbox({
      provider,
      issuer,
      sessionId: "s1",
      repoUrl: "https://example.test/repo.git",
      ttlMs: 10_000,
    });

    await sandbox.stop();
    await sandbox.stop();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(provider.stops).toBe(1);
    expect(issuer.revokes).toBe(1);
  });

  it("revokes the grant when the sandbox fails to stop", async () => {
    const provider = recordingProvider();
    provider.launch = () =>
      Promise.resolve({
        id: "sbx-doomed",
        status: () => Promise.resolve("running" as const),
        stop: () => Promise.reject(new Error("provider down")),
      });
    const issuer = countingIssuer({ TOKEN: "t" });

    const sandbox = await launchSessionSandbox({
      provider,
      issuer,
      sessionId: "s1",
      repoUrl: "https://example.test/repo.git",
    });

    await expect(sandbox.stop()).rejects.toThrow("provider down");
    expect(issuer.revokes).toBe(1);
  });

  it("revokes the grant when the sandbox never boots", async () => {
    const issuer = countingIssuer({ TOKEN: "t" });
    const provider: SandboxProvider = {
      name: "failing",
      launch: () => Promise.reject(new Error("no capacity")),
    };

    await expect(
      launchSessionSandbox({
        provider,
        issuer,
        sessionId: "s1",
        repoUrl: "https://example.test/repo.git",
      }),
    ).rejects.toThrow("no capacity");
    expect(issuer.revokes).toBe(1);
  });
});
