import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../../..");
const SCRIPT = path.join(root, "script/check-release-identity.ts");

const read = (relative: string) =>
  fs.readFile(path.join(root, relative), "utf8");

/**
 * Serve one fixed health body and run the probe against it.
 *
 * `body` is what `GET /global/health` answers; `undefined` means the endpoint is unreachable, which
 * is what a rollout in progress looks like. Timeouts are short because every rejection path here is
 * a deadline, and the point of the test is which side of it the script lands on.
 */
async function probe(body: unknown | undefined, expected: string, timeout = 2) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (body === undefined) return new Response("nope", { status: 503 });
      if (new URL(request.url).pathname !== "/global/health")
        return new Response("not found", { status: 404 });
      return Response.json(body);
    },
  });
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        SCRIPT,
        "--url",
        `http://127.0.0.1:${server.port}`,
        "--expect",
        expected,
        "--timeout",
        String(timeout),
        "--interval",
        "1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, output: stdout + stderr };
  } finally {
    await server.stop(true);
  }
}

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("release identity probe", () => {
  it("accepts a healthy instance serving the expected revision", async () => {
    const result = await probe(
      { healthy: true, version: "1.330.0", revision: SHA },
      SHA,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("Release identity matches");
  });

  // The case a package version cannot see: two uploads of the same release, where the old container
  // is still the one answering.
  it("rejects a healthy instance serving a different revision at the same version", async () => {
    const result = await probe(
      { healthy: true, version: "1.330.0", revision: OTHER },
      SHA,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("still serving");
    expect(result.output).toContain("not confirmed");
  });

  it("rejects an instance that predates revision identity", async () => {
    const result = await probe({ healthy: true, version: "1.330.0" }, SHA);
    expect(result.code).toBe(1);
    expect(result.output).toContain("predates revision identity");
  });

  it("rejects an unhealthy instance", async () => {
    const result = await probe(
      { healthy: false, version: "1.330.0", revision: SHA },
      SHA,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("unhealthy");
  });

  // A build that never completes never replaces the container, so the probe never reaches a match.
  it("rejects a timeout with nothing serving", async () => {
    const result = await probe(undefined, SHA);
    expect(result.code).toBe(1);
    expect(result.output).toContain("not confirmed");
  });

  it("refuses to run without a health URL or an expected revision", async () => {
    // Run outside a checkout so the git fallback for --expect finds nothing; the env fallbacks are
    // cleared for the same reason. Otherwise the script picks an ambient value up and runs.
    const cwd = mkdtempSync(path.join(tmpdir(), "nikcli-release-identity-"));
    try {
      for (const args of [
        ["--expect", SHA],
        ["--url", "http://127.0.0.1:1"],
      ]) {
        const proc = Bun.spawn([process.execPath, "run", SCRIPT, ...args], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NIKCLI_HEALTH_URL: "", NIKCLI_REVISION: "" },
        });
        const [stderr, code] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(2);
        expect(stderr).toContain("✗");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("release identity wiring", () => {
  it("bakes the revision into the binary as a build define", async () => {
    const build = await read("packages/nikcli/script/build.ts");
    expect(build).toContain("NIKCLI_REVISION: `'${revision}'`");
    // Env first, git second: the image that builds for Railway has no .git.
    expect(build).toContain('process.env["NIKCLI_REVISION"]');
    expect(build).toContain("git rev-parse HEAD");
  });

  it("reports the baked revision, not an environment variable read at startup", async () => {
    const version = await read("packages/util/src/version.ts");
    expect(version).toContain("const NIKCLI_REVISION: string");
    expect(version).toContain(
      'typeof NIKCLI_REVISION === "string" ? NIKCLI_REVISION : "local"',
    );
    expect(version).not.toContain("process.env");
  });

  it("serves the revision on the already-public health endpoint as an optional key", async () => {
    const global = await read("packages/nikcli/src/server/httpapi/global.ts");
    expect(global).toContain("revision: Schema.optionalKey(Schema.String)");
    expect(global).toContain("revision: Installation.REVISION");
  });

  it("keeps the generated health type in sync with the contract", async () => {
    const types = await read("packages/sdk/js/src/httpapi/generated/types.ts");
    expect(types).toContain(
      "export type GlobalHealth = { healthy: true; version: string; revision?: string }",
    );
  });

  it("passes the deployed commit into the image build", async () => {
    const dockerfile = await read("Dockerfile.serve");
    expect(dockerfile).toContain(
      'NIKCLI_REVISION="$(cat .nikcli-revision 2>/dev/null || true)"',
    );
  });

  it("stubs the TUI storybook workspace required by the nikcli manifest", async () => {
    const dockerfile = await read("Dockerfile.serve");
    expect(dockerfile).toContain(
      '"packages/tui-storybook:@nikcli-ai/tui-storybook"',
    );
  });

  it("writes the expected identity into the upload context after the source sync", async () => {
    const deploy = await read("script/railway-deploy.sh");
    const rsyncIndex = deploy.indexOf('rsync "${RSYNC_OPTS[@]}"');
    const writeIndex = deploy.indexOf(
      '> "$CTX/packages/nikcli/.nikcli-revision"',
    );
    expect(rsyncIndex).toBeGreaterThan(-1);
    // `rsync --delete` runs first and would remove the file if it were written before the loop.
    expect(writeIndex).toBeGreaterThan(rsyncIndex);
    expect(deploy).toContain("Expected release identity");
  });

  it("refuses to upload a build whose commit cannot be determined", async () => {
    const deploy = await read("script/railway-deploy.sh");
    expect(deploy).toContain("Cannot determine the commit being deployed");
  });

  it("confirms identity after the detached upload rather than trusting it", async () => {
    const yml = await read(".github/workflows/ci-pipeline.yml");
    const deployIndex = yml.indexOf("./script/railway-deploy.sh --detach");
    const confirmIndex = yml.indexOf("script/check-release-identity.ts");
    expect(deployIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(deployIndex);
    expect(yml).toContain(
      'NIKCLI_REVISION="$GITHUB_SHA" ./script/railway-deploy.sh --detach',
    );
    expect(yml).toContain("Expected identity: revision=${GITHUB_SHA}");
    expect(yml).toContain("https://nikcli-mobile-production.up.railway.app");
    // GitHub expressions treat `//` as a comment, so the default URL cannot live inside ${{ }}.
    expect(yml).not.toMatch(/\$\{\{[^}\n]*https:\/\//);
  });
});
