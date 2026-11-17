/**
 * A game deleted on genex.games stops reading "Live" in Studio: once Genex, asked with a working
 * sign-in, knows neither the game's link nor its id, the publish record forgets the page and the
 * apps it sent, and the link is set aside (never deleted), so the dialog says the game is not
 * published. Genex not answering, a dead sign-in, or a game moved to another link change nothing.
 *
 * GenexTools runs against the fixture Genex API on this machine.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { CLOUD_BUILD_FILE } from "../../src/plugins/genex/cloud-build.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { CloudBuildState, type GenexPublishState } from "../../src/shared/genex.ts";
import { type GenexFixtureApi, type GenexRequest, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "bodycam-game";
const SLUG = "genex-cs";
const PROJECT_ID = "p-cs";
const SENT_AT = "2026-11-12T10:00:00.000Z";
const DAY_MS = 24 * 60 * MINUTE_MS;
const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

type Answer = (request: GenexRequest) => { body: unknown; status?: number } | undefined;

/** Genex answering the sign-in as `user` and every other read with `answer`; the requests it saw. */
async function genexAnswering(answer: Answer, user: unknown = { id: "u-me" }) {
  const requests: GenexRequest[] = [];
  const server = await startGenexFixtureApi((request, reply) => {
    requests.push(request);
    if (request.url === "/api/auth/get-session") return reply.json({ user });
    const said = answer(request);
    if (said) return reply.json(said.body, said.status ?? 200);
  });
  servers.push(server);
  return { server, requests };
}

const notFound = { body: { error: "Not found" }, status: 404 };

/** Studio's publish workspace of a game that went live with a web version, a Mac app and a Windows app. */
async function livePublish(api: string, signedIn = true, sinceSentMs = DAY_MS) {
  const root = await tmpDir("studio-genex-deleted-game-");
  const genex = new GenexTools(path.join(root, "host"), api, {
    now: () => Date.parse(SENT_AT) + sinceSentMs,
    credentials: {
      get: async () => (signedIn ? "fixture-token" : null),
      set: async () => undefined,
      clear: async () => undefined,
    },
  });
  const dir = path.join(genex.root, "publish", PROJECT);
  await mkdir(path.join(dir, ".genex"), { recursive: true });
  await writeFile(
    path.join(dir, ".genex", "project.json"),
    JSON.stringify({ slug: SLUG, id: PROJECT_ID, status: "published" }),
  );
  const record: GenexPublishState = {
    version: 1,
    project: PROJECT,
    connected: true,
    title: "Genex strike",
    slug: SLUG,
    projectId: PROJECT_ID,
    status: "published",
    lastPublishAt: SENT_AT,
  };
  await writeFile(path.join(dir, "publish.json"), JSON.stringify(record));
  const sent = (platform: string, arch: string) => ({
    platform,
    arch,
    version: "1",
    sizeBytes: 9,
    publishedAt: SENT_AT,
  });
  await writeFile(
    path.join(dir, "native.json"),
    JSON.stringify({ jobId: "j1", sent: [sent("mac", "universal"), sent("windows", "x64")], failed: [] }),
  );
  const windowsBuild = { platform: "windows", jobId: "job_1", state: CloudBuildState.Done, startedAt: SENT_AT };
  await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [windowsBuild] }));
  const read = async (file: string) => JSON.parse(await readFile(path.join(dir, file), "utf8"));
  const kept = async () => (await readdir(path.join(dir, ".genex"))).sort();
  return { genex, read, kept };
}

/** What the dialog's rows would say: still listed, and the platforms of the apps it shows as sent. */
const listed = (state: GenexPublishState) => ({
  status: state.status,
  slug: state.slug,
  apps: state.native?.sent.map((app) => app.platform) ?? [],
});

describe("a game deleted on genex.games", () => {
  it("reads as not published: the page and the apps it sent are forgotten, the link is set aside", async () => {
    const { server } = await genexAnswering((request) =>
      request.url === `/api/projects/by-slug/${SLUG}` || request.url === `/api/projects/${PROJECT_ID}`
        ? notFound
        : undefined,
    );
    const { genex, read, kept } = await livePublish(server.url);
    const state = await genex.publishView(PROJECT);
    assert.deepEqual(listed(state), { status: undefined, slug: undefined, apps: [] });
    assert.equal(state.lastPublishAt, undefined, 'no "Live · 5d ago" for a page that is gone');
    assert.equal(state.title, "Genex strike", "the game keeps its name");
    assert.deepEqual((await read(CLOUD_BUILD_FILE)).builds, [], "Genex Cloud's app is no longer what players have");
    const names = await kept();
    assert.equal(names.includes("project.json"), false, "the dead link no longer stands");
    assert.equal(
      names.filter((name) => name.startsWith("project.unlinked-")).length,
      1,
      "it is set aside, not deleted",
    );
    assert.deepEqual(listed(await genex.publishView(PROJECT)), { status: undefined, slug: undefined, apps: [] });
  });

  it("is left as it was when Genex cannot say, or the sign-in no longer holds", async () => {
    const cases = [
      { what: "Genex failing", user: { id: "u-me" }, answer: { body: { error: "boom" }, status: 500 } },
      { what: "a dead sign-in", user: null, answer: notFound },
    ];
    for (const { what, user, answer } of cases) {
      const { server } = await genexAnswering(
        (request) => (request.url.startsWith("/api/projects/") ? answer : undefined),
        user,
      );
      const { genex, kept } = await livePublish(server.url);
      const state = await genex.publishView(PROJECT);
      assert.deepEqual(listed(state), { status: "published", slug: SLUG, apps: ["mac", "windows"] }, what);
      assert.deepEqual(await kept(), ["project.json"], `${what}: nothing set aside`);
    }
  });

  it("is left as it was while it went out a moment ago: Genex may not list it yet", async () => {
    const { server } = await genexAnswering(() => notFound);
    const { genex, kept } = await livePublish(server.url, true, MINUTE_MS);
    const state = await genex.publishView(PROJECT);
    assert.deepEqual(listed(state), { status: "published", slug: SLUG, apps: ["mac", "windows"] });
    assert.deepEqual(await kept(), ["project.json"]);
  });

  it("is left as it was while signed out", async () => {
    const { server, requests } = await genexAnswering(() => notFound);
    const { genex, kept } = await livePublish(server.url, false);
    const state = await genex.publishView(PROJECT);
    assert.deepEqual(listed(state), { status: "published", slug: SLUG, apps: ["mac", "windows"] });
    assert.deepEqual(await kept(), ["project.json"]);
    assert.deepEqual(requests, [], "Genex is asked nothing without a sign-in");
  });

  it("is not forgotten when Genex only moved it to another link", async () => {
    const { server } = await genexAnswering((request) => {
      if (request.url === `/api/projects/by-slug/${SLUG}`) return notFound;
      if (request.url === `/api/projects/${PROJECT_ID}`)
        return { body: { project: { id: PROJECT_ID, slug: "genex-strike", status: "published" } } };
      return undefined;
    });
    const { genex } = await livePublish(server.url);
    const state = await genex.publishView(PROJECT);
    assert.deepEqual(listed(state), { status: "published", slug: "genex-strike", apps: ["mac", "windows"] });
  });
});
